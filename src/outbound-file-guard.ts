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

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebexChannelConfig } from './types';

/**
 * Default allowed roots when config.outboundFileRoots is unset.
 *
 * workspace/outbound is a purpose-built directory for deliberate
 * outbound artifacts — NOT the workspace root, which also holds live
 * secrets. This code never creates the directory; if it doesn't exist,
 * fs.realpathSync on any path claimed to live under it throws ENOENT,
 * which resolveAllowedOutboundFile treats as a clean denial.
 */
/**
 * Resolve the OpenClaw state dir portably — OPENCLAW_STATE_DIR when set,
 * else ~/.openclaw. Matches how channel-plugin.ts resolves config/workspace
 * paths; never hardcode an absolute user path here (breaks on any other host).
 */
function resolveStateDir(): string {
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  return process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), '.openclaw');
}

export const DEFAULT_OUTBOUND_FILE_ROOTS: string[] = (() => {
  const path = require('node:path') as typeof import('node:path');
  const state = resolveStateDir();
  return [
    path.join(state, 'workspace', 'outbound'),
    // OpenClaw core's managed outbound-media staging directory: when an agent
    // emits a MEDIA: directive, core's own normalizer copies the (already
    // vetted) file here and hands the channel THIS path — not the agent's
    // original. Confirmed live: renders land as media/outbound/<name>---<uuid>.<ext>.
    path.join(state, 'media', 'outbound'),
    '/tmp',
  ];
})();

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

const GENERIC_REJECTION_MESSAGE =
  'resolveAllowedOutboundFile: file path not permitted for outbound send';

/**
 * Reject with a single generic message so a caller that can see the
 * thrown error (ultimately, an agent whose output reaches a Webex room)
 * can't use error-message content as a path-existence/symlink-target
 * oracle. The specific reason is still logged locally via console.warn
 * for operators debugging a legitimate rejection.
 */
function reject(reason: string): never {
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
export function resolveAllowedOutboundFile(
  rawPath: string,
  config: WebexChannelConfig
): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    reject('path must be a non-empty string');
  }

  let candidate = rawPath;
  if (candidate.startsWith('file://')) {
    try {
      candidate = fileURLToPath(candidate);
    } catch (err) {
      reject(
        `invalid file:// URL "${rawPath}": ${err instanceof Error ? err.message : err}`
      );
    }
  }

  if (!path.isAbsolute(candidate)) {
    reject(`relative paths are not allowed ("${rawPath}")`);
  }

  let canonical: string;
  try {
    canonical = fs.realpathSync(candidate);
  } catch (err) {
    reject(
      `cannot resolve "${rawPath}": ${err instanceof Error ? err.message : err}`
    );
  }

  const roots =
    config.outboundFileRoots && config.outboundFileRoots.length > 0
      ? config.outboundFileRoots
      : DEFAULT_OUTBOUND_FILE_ROOTS;

  const withinAllowedRoot = roots.some((root) => {
    let canonicalRoot: string;
    try {
      canonicalRoot = fs.realpathSync(root);
    } catch {
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
    reject(
      `"${canonical}" is outside the allowed outbound file roots (${roots.join(', ')})`
    );
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

  if (
    DENIED_BASENAMES.has(basenameLower) ||
    basename.startsWith('.') ||
    /\.bak/i.test(basename) ||
    basenameLower.includes('credential') ||
    basenameLower.includes('secret')
  ) {
    reject(`"${canonical}" matches a denied filename`);
  }

  return canonical;
}
