/**
 * Webex attachment download helper.
 *
 * Webex file URLs (https://webexapis.com/v1/contents/<id>) require a bot token
 * to fetch. OpenClaw core expects attachments as local file paths, so we
 * download once at webhook ingestion and stash the bytes under os.tmpdir().
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import fetch from 'node-fetch';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Content types we are willing to write to disk.
 * prevents a user from uploading e.g. an .exe renamed .jpg — the content
 * type comes from the HTTP response (Webex), not the filename.
 */
export const DEFAULT_ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  // Images
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/heic",
  // Documents
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
  "application/xml",
  "text/xml",
  "application/zip",
  "application/x-yaml",
  "text/yaml",
  // Office docs
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

export interface DownloadedAttachment {
  localPath: string;
  contentType?: string;
  name?: string;
  size: number;
}

export interface DownloadOptions {
  maxBytes?: number;
  /**
   * Override the accepted content types. Pass a Set to restrict, or
   * undefined to use the default allowlist.
   */
  allowedContentTypes?: ReadonlySet<string>;
  /** Injected for tests */
  fetchImpl?: typeof fetch;
  /** Injected for tests */
  tmpDir?: string;
  /** Non-fatal warning hook (e.g. type rejected). */
  onWarn?: (message: string) => void;
}

export async function downloadWebexAttachment(
  url: string,
  token: string,
  options: DownloadOptions = {}
): Promise<DownloadedAttachment | null> {
  const maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
  const doFetch = options.fetchImpl ?? fetch;
  const tmpDir = options.tmpDir ?? os.tmpdir();

  const response = await doFetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(
      `Attachment download failed: ${response.status} ${response.statusText}`
    );
  }

  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength && declaredLength > maxBytes) {
    return null;
  }

  const contentType =
    stripCharset(response.headers.get('content-type')) ?? undefined;
  const name = parseFilenameFromDisposition(
    response.headers.get('content-disposition') ?? ''
  );

  // MIME validation — reject anything outside the configured allowlist.
  const allowed = options.allowedContentTypes ?? DEFAULT_ALLOWED_CONTENT_TYPES;
  if (contentType && !allowed.has(contentType)) {
    options.onWarn?.(`rejected attachment: unsupported content-type ${contentType}`);
    return null;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    return null;
  }

  const fileName = `webex-${crypto.randomUUID()}${extensionFor(name, contentType)}`;
  const localPath = path.join(tmpDir, fileName);
  await fs.writeFile(localPath, buffer);

  return { localPath, contentType, name, size: buffer.length };
}

function parseFilenameFromDisposition(disposition: string): string | undefined {
  if (!disposition) return undefined;

  // RFC 5987: filename*=UTF-8''encoded.ext takes precedence when present.
  const starMatch = disposition.match(/filename\*=(?:[^']*'[^']*')?([^;]+)/i);
  if (starMatch) {
    try {
      return decodeURIComponent(starMatch[1].trim().replace(/^"|"$/g, ''));
    } catch {
      // fall through to filename= form
    }
  }

  const match = disposition.match(/filename="?([^";]+)"?/i);
  return match ? match[1].trim() : undefined;
}

function stripCharset(contentType: string | null): string | undefined {
  if (!contentType) return undefined;
  return contentType.split(';')[0].trim().toLowerCase() || undefined;
}

function extensionFor(name?: string, contentType?: string): string {
  if (name) {
    const dot = name.lastIndexOf('.');
    if (dot > 0 && dot < name.length - 1) {
      return name.slice(dot);
    }
  }
  if (!contentType) return '';

  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/csv': '.csv',
    'application/json': '.json',
    'application/zip': '.zip',
  };
  return map[contentType] ?? '';
}
