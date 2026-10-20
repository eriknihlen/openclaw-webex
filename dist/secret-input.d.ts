/**
 * SecretRef-aware credential reads for Webex config fields.
 *
 * `channels.webex.token`, `channels.webex.accounts.<id>.token` and
 * `aiopsApprovalSecret` (top-level or per account) accept either a
 * plaintext string or an OpenClaw SecretRef object such as
 * `{ source: "store", provider: "teamstore", id: "MARCUS_WEBEX_BOT_TOKEN" }`.
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
export declare function isWebexSecretRef(value: unknown): value is WebexSecretRef;
/** Classifies a secret-capable config value without exposing it. */
export declare function webexSecretStatus(value: unknown): WebexSecretStatus;
/**
 * Returns the usable credential string, or undefined when the value is
 * missing or is an unresolved SecretRef. Never returns a non-string.
 */
export declare function readWebexSecretString(value: unknown): string | undefined;
/**
 * True when a value counts as "set" for inheritance purposes: either a
 * non-empty string or a SecretRef object. Used so an account-level
 * SecretRef overrides the section-level value instead of falling
 * through to it.
 */
export declare function hasWebexSecretInput(value: unknown): boolean;
/**
 * Error message for an unresolved SecretRef. Names the config path and
 * the remedy only; never includes the ref id or any value.
 */
export declare function unresolvedWebexSecretMessage(path: string): string;
