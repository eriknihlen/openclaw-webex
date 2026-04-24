"use strict";
/**
 * Webex attachment download helper.
 *
 * Webex file URLs (https://webexapis.com/v1/contents/<id>) require a bot token
 * to fetch. OpenClaw core expects attachments as local file paths, so we
 * download once at webhook ingestion and stash the bytes under os.tmpdir().
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_ALLOWED_CONTENT_TYPES = exports.MAX_ATTACHMENT_BYTES = void 0;
exports.downloadWebexAttachment = downloadWebexAttachment;
const crypto = __importStar(require("node:crypto"));
const fs = __importStar(require("node:fs/promises"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const node_fetch_1 = __importDefault(require("node-fetch"));
exports.MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/**
 * Content types we are willing to write to disk.
 * prevents a user from uploading e.g. an .exe renamed .jpg — the content
 * type comes from the HTTP response (Webex), not the filename.
 */
exports.DEFAULT_ALLOWED_CONTENT_TYPES = new Set([
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
async function downloadWebexAttachment(url, token, options = {}) {
    const maxBytes = options.maxBytes ?? exports.MAX_ATTACHMENT_BYTES;
    const doFetch = options.fetchImpl ?? node_fetch_1.default;
    const tmpDir = options.tmpDir ?? os.tmpdir();
    const response = await doFetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
        throw new Error(`Attachment download failed: ${response.status} ${response.statusText}`);
    }
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength && declaredLength > maxBytes) {
        return null;
    }
    const contentType = stripCharset(response.headers.get('content-type')) ?? undefined;
    const name = parseFilenameFromDisposition(response.headers.get('content-disposition') ?? '');
    // MIME validation — reject anything outside the configured allowlist.
    const allowed = options.allowedContentTypes ?? exports.DEFAULT_ALLOWED_CONTENT_TYPES;
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
function parseFilenameFromDisposition(disposition) {
    if (!disposition)
        return undefined;
    // RFC 5987: filename*=UTF-8''encoded.ext takes precedence when present.
    const starMatch = disposition.match(/filename\*=(?:[^']*'[^']*')?([^;]+)/i);
    if (starMatch) {
        try {
            return decodeURIComponent(starMatch[1].trim().replace(/^"|"$/g, ''));
        }
        catch {
            // fall through to filename= form
        }
    }
    const match = disposition.match(/filename="?([^";]+)"?/i);
    return match ? match[1].trim() : undefined;
}
function stripCharset(contentType) {
    if (!contentType)
        return undefined;
    return contentType.split(';')[0].trim().toLowerCase() || undefined;
}
function extensionFor(name, contentType) {
    if (name) {
        const dot = name.lastIndexOf('.');
        if (dot > 0 && dot < name.length - 1) {
            return name.slice(dot);
        }
    }
    if (!contentType)
        return '';
    const map = {
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
//# sourceMappingURL=download.js.map