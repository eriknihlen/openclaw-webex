/**
 * SecretRef-aware credential reads for Webex config fields.
 *
 * `channels.webex.token`, `channels.webex.accounts.<id>.token` and
 * `aiopsApprovalSecret` (top-level or per account) accept either a
 * plaintext string or an OpenClaw SecretRef object such as
 * `{ source: "store", provider: "teamstore", id: "WEBEX_BOT_TOKEN" }`.
 *
 * The plugin never resolves SecretRefs itself. The gateway resolves them
 * through the channel secret contract (see secret-contract-api.ts) and
 * hands the plugin a runtime config in which those fields are already
 * plain strings. A SecretRef object that is still present when the
 * plugin reads the config means resolution did not happen (read-only
 * CLI path, contract not deployed, or the owner failed to resolve and
 * was isolated by the gateway). Those values are reported as
 * "configured_unavailable" and must never be used as credentials.
 *
 * Nothing here ever logs, returns or stringifies a secret value or a
 * SecretRef id.
 */

/** Structured OpenClaw SecretRef as it appears in openclaw.json. */
export interface WebexSecretRef {
  source: string;
  provider?: string;
  id: string;
}

/** A config value that may hold a plaintext secret or a SecretRef. */
export type WebexSecretInput = string | WebexSecretRef;

/**
 * - `available`: a usable plaintext (or gateway-resolved) string.
 * - `configured_unavailable`: a SecretRef that has not been resolved.
 * - `missing`: nothing configured (undefined, null, empty string).
 */
export type WebexSecretStatus = "available" | "configured_unavailable" | "missing";

/** True for a structured SecretRef object (`{ source, id, provider? }`). */
export function isWebexSecretRef(value: unknown): value is WebexSecretRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.source === "string" &&
    record.source.length > 0 &&
    typeof record.id === "string" &&
    record.id.length > 0 &&
    (record.provider === undefined || typeof record.provider === "string")
  );
}

/** Classifies a secret-capable config value without exposing it. */
export function webexSecretStatus(value: unknown): WebexSecretStatus {
  if (typeof value === "string") {
    return value.trim().length > 0 ? "available" : "missing";
  }
  if (isWebexSecretRef(value)) return "configured_unavailable";
  return "missing";
}

/**
 * Returns the usable credential string, or undefined when the value is
 * missing or is an unresolved SecretRef. Never returns a non-string.
 */
export function readWebexSecretString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * True when a value counts as "set" for inheritance purposes: either a
 * non-empty string or a SecretRef object. Used so an account-level
 * SecretRef overrides the section-level value instead of falling
 * through to it.
 */
export function hasWebexSecretInput(value: unknown): boolean {
  return webexSecretStatus(value) !== "missing";
}

/**
 * Error message for an unresolved SecretRef. Names the config path and
 * the remedy only; never includes the ref id or any value.
 */
export function unresolvedWebexSecretMessage(path: string): string {
  return (
    `${path} is a SecretRef that the OpenClaw gateway did not resolve. ` +
    `Check that the plugin's dist/secret-contract-api.js is deployed, the ` +
    `referenced secret exists, then run 'openclaw secrets audit --check' ` +
    `and restart the gateway.`
  );
}
