/**
 * Webex attachment download helper.
 *
 * Webex file URLs (https://webexapis.com/v1/contents/<id>) require a bot token
 * to fetch. OpenClaw core expects attachments as local file paths, so we
 * download once at webhook ingestion and stash the bytes under os.tmpdir().
 */
import fetch from 'node-fetch';
export declare const MAX_ATTACHMENT_BYTES: number;
/**
 * Content types we are willing to write to disk.
 * prevents a user from uploading e.g. an .exe renamed .jpg — the content
 * type comes from the HTTP response (Webex), not the filename.
 */
export declare const DEFAULT_ALLOWED_CONTENT_TYPES: ReadonlySet<string>;
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
    /** Injected for tests; also the inbound folder when the account sets inboundDir. */
    tmpDir?: string;
    /** Save under the file's own name (timestamp-prefixed) instead of a random one. */
    keepName?: boolean;
    /** Non-fatal warning hook (e.g. type rejected). */
    onWarn?: (message: string) => void;
}
export declare function downloadWebexAttachment(url: string, token: string, options?: DownloadOptions): Promise<DownloadedAttachment | null>;
/** A file name that is safe on disk: no folders, no leading dot, at most 120 characters. */
export declare function safeFileName(name: string): string;
/** Delete files older than maxAgeMs in an inbound folder (best effort). */
export declare function pruneInboundDir(dir: string, maxAgeMs: number): Promise<void>;
