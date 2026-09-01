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

// Webex scans/processes newly uploaded files server-side; while that's in
// flight, the content URL returns 423 (Locked) for a few seconds. 429 (Too
// Many Requests) gets the same bounded-retry treatment. Every other non-OK
// status fails immediately, same as before.
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([423, 429]);
/** Total attempts (1 initial + up to 4 retries) before giving up. */
const MAX_DOWNLOAD_ATTEMPTS = 5;
/** Base of the exponential backoff: 1s, 2s, 4s, 8s, ... */
const RETRY_BASE_DELAY_MS = 1000;
/** Backoff is capped so a single wait never balloons. */
const RETRY_MAX_BACKOFF_MS = 8000;
/** Upper bound honored even when the server's Retry-After asks for more. */
const RETRY_AFTER_CAP_MS = 8000;
/** Small random jitter added to computed (non-Retry-After) backoff. */
const RETRY_JITTER_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parses a Retry-After header (seconds form) into a capped millisecond delay. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
}

function computeBackoffMs(attempt: number): number {
  // attempt is 1-based for the *retry* number (1st retry, 2nd retry, ...).
  const exponential = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  const capped = Math.min(exponential, RETRY_MAX_BACKOFF_MS);
  return capped + Math.floor(Math.random() * RETRY_JITTER_MS);
}

export async function downloadWebexAttachment(
  url: string,
  token: string,
  options: DownloadOptions = {}
): Promise<DownloadedAttachment | null> {
  const maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
  const doFetch = options.fetchImpl ?? fetch;
  const tmpDir = options.tmpDir ?? os.tmpdir();

  let response: Awaited<ReturnType<typeof doFetch>> | undefined;
  for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
    response = await doFetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.ok) break;

    const retryable = RETRYABLE_STATUSES.has(response.status);
    const attemptsExhausted = attempt >= MAX_DOWNLOAD_ATTEMPTS;

    if (!retryable) {
      throw new Error(
        `Attachment download failed: ${response.status} ${response.statusText}`
      );
    }

    if (attemptsExhausted) {
      throw new Error(
        `Attachment download failed: ${response.status} ${response.statusText} ` +
          `(still locked after ${attempt} attempts)`
      );
    }

    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    const delayMs = retryAfterMs ?? computeBackoffMs(attempt);
    options.onWarn?.(
      `attachment download got ${response.status}, retrying in ${delayMs}ms ` +
        `(attempt ${attempt}/${MAX_DOWNLOAD_ATTEMPTS})`
    );
    await sleep(delayMs);
  }

  // Loop always either returns via throw or leaves `response` set to the
  // final (ok) response before falling through.
  const okResponse = response!;

  const declaredLength = Number(okResponse.headers.get('content-length') ?? 0);
  if (declaredLength && declaredLength > maxBytes) {
    return null;
  }

  const contentType =
    stripCharset(okResponse.headers.get('content-type')) ?? undefined;
  const name = parseFilenameFromDisposition(
    okResponse.headers.get('content-disposition') ?? ''
  );

  // MIME validation — reject anything outside the configured allowlist.
  const allowed = options.allowedContentTypes ?? DEFAULT_ALLOWED_CONTENT_TYPES;
  if (contentType && !allowed.has(contentType)) {
    options.onWarn?.(`rejected attachment: unsupported content-type ${contentType}`);
    return null;
  }

  const buffer = Buffer.from(await okResponse.arrayBuffer());
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
