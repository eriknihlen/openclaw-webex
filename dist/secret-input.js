"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.isWebexSecretRef = isWebexSecretRef;
exports.webexSecretStatus = webexSecretStatus;
exports.readWebexSecretString = readWebexSecretString;
exports.hasWebexSecretInput = hasWebexSecretInput;
exports.unresolvedWebexSecretMessage = unresolvedWebexSecretMessage;
/** True for a structured SecretRef object (`{ source, id, provider? }`). */
function isWebexSecretRef(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const record = value;
    return (typeof record.source === "string" &&
        record.source.length > 0 &&
        typeof record.id === "string" &&
        record.id.length > 0 &&
        (record.provider === undefined || typeof record.provider === "string"));
}
/** Classifies a secret-capable config value without exposing it. */
function webexSecretStatus(value) {
    if (typeof value === "string") {
        return value.trim().length > 0 ? "available" : "missing";
    }
    if (isWebexSecretRef(value))
        return "configured_unavailable";
    return "missing";
}
/**
 * Returns the usable credential string, or undefined when the value is
 * missing or is an unresolved SecretRef. Never returns a non-string.
 */
function readWebexSecretString(value) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
/**
 * True when a value counts as "set" for inheritance purposes: either a
 * non-empty string or a SecretRef object. Used so an account-level
 * SecretRef overrides the section-level value instead of falling
 * through to it.
 */
function hasWebexSecretInput(value) {
    return webexSecretStatus(value) !== "missing";
}
/**
 * Error message for an unresolved SecretRef. Names the config path and
 * the remedy only; never includes the ref id or any value.
 */
function unresolvedWebexSecretMessage(path) {
    return (`${path} is a SecretRef that the OpenClaw gateway did not resolve. ` +
        `Check that the plugin's dist/secret-contract-api.js is deployed, the ` +
        `referenced secret exists, then run 'openclaw secrets audit --check' ` +
        `and restart the gateway.`);
}
//# sourceMappingURL=secret-input.js.map