"use strict";
/**
 * Path-safety gate for outbound local file sends.
 *
 * Marcus (the agent) can hand the plugin a local path — a rendered
 * diagram, a report file — that it wants delivered to Webex via
 * WebexSender.sendLocalFile (multipart upload). Nothing upstream of this
 * gate validates that path: outbound.sendMedia's mediaUrl and the
 * long-reply auto-attach temp file both flow straight into it. Get this
 * wrong and the bot becomes a way to exfiltrate any file the process can
 * read — SSH keys, the gateway config carrying the bot token, `.git`
 * internals, or the agent's own memory/secrets files sitting in its
 * workspace — to whichever Webex room asked for it.
 *
 * The workspace root is NOT an acceptable allowed root by itself: it
 * holds live secrets alongside agent output (e.g. a hardcoded DB
 * credential in configs/aiops/dashboard/db_config.py, SECRETS.md,
 * assorted *.bak snapshots of memory files). No deny-list over that root
 * can be complete. The real guard is the combination of (1) a
 * purpose-built default root — workspace/outbound — that holds nothing
 * but deliberately-produced artifacts, plus /tmp for the long-reply
 * temp file, and (2) an extension allowlist restricted to attachment-safe
 * output formats. The segment/basename deny-list below is kept only as
 * defense-in-depth on top of those two, not as the primary control.
 *
 * resolveAllowedOutboundFile() is the only sanctioned way to turn an
 * agent-supplied path into one that's safe to open and upload. It never
 * falls back to sending on rejection — every failure mode throws.
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_OUTBOUND_FILE_ROOTS = void 0;
exports.resolveAllowedOutboundFile = resolveAllowedOutboundFile;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_url_1 = require("node:url");
/**
 * Default allowed roots when config.outboundFileRoots is unset.
 *
 * workspace/outbound is a purpose-built directory for deliberate
 * outbound artifacts — NOT the workspace root, which also holds live
 * secrets. This code never creates the directory; if it doesn't exist,
 * fs.realpathSync on any path claimed to live under it throws ENOENT,
 * which resolveAllowedOutboundFile treats as a clean denial.
 */
exports.DEFAULT_OUTBOUND_FILE_ROOTS = [
    '/home/claw/.openclaw/workspace/outbound',
    '/tmp',
];
/**
 * Extensions eligible for outbound send, matched case-insensitively
 * against the canonical file's extension. This is the primary control,
 * not the deny-list below: it keeps the gate from ever handing over
 * source/config/env files (.py, .yaml, .env, .bak, .sh, ...) regardless
 * of which directory they happen to sit in.
 */
const ALLOWED_EXTENSIONS = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.pdf',
    '.txt',
    '.md',
    '.csv',
    '.json',
    '.xml',
    '.log',
    '.zip',
]);
/**
 * Path segments that are denied outright regardless of which allowed
 * root the file lives under, matched case-insensitively against every
 * segment of the canonicalized path (not just the basename). Defense in
 * depth on top of the root + extension checks above.
 */
const DENIED_SEGMENTS = new Set(['credentials', 'secrets', '.ssh', '.git']);
/** Basenames denied outright regardless of extension or root. */
const DENIED_BASENAMES = new Set(['openclaw.json']);
const GENERIC_REJECTION_MESSAGE = 'resolveAllowedOutboundFile: file path not permitted for outbound send';
/**
 * Reject with a single generic message so a caller that can see the
 * thrown error (ultimately, an agent whose output reaches a Webex room)
 * can't use error-message content as a path-existence/symlink-target
 * oracle. The specific reason is still logged locally via console.warn
 * for operators debugging a legitimate rejection.
 */
function reject(reason) {
    console.warn(`[outbound-file-guard] rejected outbound file: ${reason}`);
    throw new Error(GENERIC_REJECTION_MESSAGE);
}
/**
 * Canonicalize and validate an agent-supplied outbound file path.
 *
 * - Accepts absolute paths and file:// URLs; rejects everything else
 *   (relative paths included) before touching the filesystem.
 * - Resolves symlinks and `..` via fs.realpathSync, so a symlink that
 *   points outside the allowed roots is caught by the containment check
 *   below — realpath dereferences it first, there is no separate
 *   "is this a symlink" check needed.
 * - Requires the canonical path to sit inside one of config
 *   .outboundFileRoots (default: DEFAULT_OUTBOUND_FILE_ROOTS), checked
 *   with path.relative so "/tmp-evil" can't pass a naive startsWith("/tmp")
 *   check.
 * - Requires the canonical file's extension to be in ALLOWED_EXTENSIONS.
 * - Applies a hard deny-list of path segments/basenames on top of the
 *   above — being inside an allowed root with an allowed extension is
 *   necessary but not sufficient.
 *
 * Throws a single generic Error on any rejection (see GENERIC_REJECTION_
 * MESSAGE) — the specific reason goes to console.warn only, never into
 * the thrown message. Never returns a path that hasn't passed every
 * check.
 */
function resolveAllowedOutboundFile(rawPath, config) {
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
        reject('path must be a non-empty string');
    }
    let candidate = rawPath;
    if (candidate.startsWith('file://')) {
        try {
            candidate = (0, node_url_1.fileURLToPath)(candidate);
        }
        catch (err) {
            reject(`invalid file:// URL "${rawPath}": ${err instanceof Error ? err.message : err}`);
        }
    }
    if (!path.isAbsolute(candidate)) {
        reject(`relative paths are not allowed ("${rawPath}")`);
    }
    let canonical;
    try {
        canonical = fs.realpathSync(candidate);
    }
    catch (err) {
        reject(`cannot resolve "${rawPath}": ${err instanceof Error ? err.message : err}`);
    }
    const roots = config.outboundFileRoots && config.outboundFileRoots.length > 0
        ? config.outboundFileRoots
        : exports.DEFAULT_OUTBOUND_FILE_ROOTS;
    const withinAllowedRoot = roots.some((root) => {
        let canonicalRoot;
        try {
            canonicalRoot = fs.realpathSync(root);
        }
        catch {
            // Root doesn't exist / isn't reachable — fall back to a resolved
            // (not realpath'd) form so a misconfigured root simply fails the
            // containment check below instead of throwing here. In practice
            // a missing root already denies every candidate earlier, at the
            // realpathSync(candidate) call above, since a file "inside" a
            // nonexistent directory can't itself resolve either.
            canonicalRoot = path.resolve(root);
        }
        const rel = path.relative(canonicalRoot, canonical);
        // Segment-safe containment: rel === "" means the same path; a rel
        // that starts with ".." or is itself absolute means canonical is
        // outside canonicalRoot. Deliberately not a startsWith() string
        // check, which "/tmp-evil/foo" would incorrectly pass against "/tmp".
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    if (!withinAllowedRoot) {
        reject(`"${canonical}" is outside the allowed outbound file roots (${roots.join(', ')})`);
    }
    const basename = path.basename(canonical);
    const basenameLower = basename.toLowerCase();
    const ext = path.extname(basenameLower);
    if (!ALLOWED_EXTENSIONS.has(ext)) {
        reject(`"${canonical}" has a disallowed extension ("${ext || '<none>'}")`);
    }
    const segments = canonical.toLowerCase().split(path.sep);
    if (segments.some((seg) => DENIED_SEGMENTS.has(seg))) {
        reject(`"${canonical}" matches a denied path segment`);
    }
    if (DENIED_BASENAMES.has(basenameLower) ||
        basename.startsWith('.') ||
        /\.bak/i.test(basename) ||
        basenameLower.includes('credential') ||
        basenameLower.includes('secret')) {
        reject(`"${canonical}" matches a denied filename`);
    }
    return canonical;
}
//# sourceMappingURL=outbound-file-guard.js.map