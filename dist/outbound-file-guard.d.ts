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
import type { WebexChannelConfig } from './types';
export declare const DEFAULT_OUTBOUND_FILE_ROOTS: string[];
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
export declare function resolveAllowedOutboundFile(rawPath: string, config: WebexChannelConfig): string;
