/**
 * Webex channel secret contract.
 *
 * OpenClaw only resolves SecretRefs inside `channels.<id>` when the
 * owning channel plugin declares a channel secret contract. For external
 * (non-bundled) plugins in OpenClaw 2026.10.x the host discovers it by
 * convention: it looks for `secret-contract-api.{js,mjs,cjs}` (then
 * `contract-api.*`) in `<pluginRoot>/dist` and `<pluginRoot>`, loads it
 * with the plugin module loader, and uses its `secretTargetRegistryEntries`
 * (for `secrets audit/configure/apply`) and `collectRuntimeConfigAssignments`
 * (for gateway startup / `secrets reload` materialization).
 * See dist/target-registry-query-*.mjs (resolvePluginContractApiPath,
 * loadExternalChannelSecretContractFromRecord) in the OpenClaw package.
 *
 * This module only builds the contract from the host SDK helpers that
 * are passed in, so it can be unit-tested without a host install. The
 * artifact the host actually loads is secret-contract-api.ts.
 */

export const WEBEX_CHANNEL_KEY = "webex";

/** Credential fields that accept a SecretRef, both top-level and per account. */
export const WEBEX_SECRET_FIELDS = ["token", "aiopsApprovalSecret"] as const;

/** Minimal shape of the host SDK registry entry (openclaw/plugin-sdk). */
export interface WebexSecretTargetRegistryEntry {
  id: string;
  targetType: string;
  configFile: string;
  pathPattern: string;
  secretShape: string;
  expectedResolvedValue: string;
  includeInPlan: boolean;
  includeInConfigure: boolean;
  includeInAudit: boolean;
  [key: string]: unknown;
}

export interface WebexChannelSecretContract {
  secretTargetRegistryEntries: WebexSecretTargetRegistryEntry[];
  collectRuntimeConfigAssignments: (params: {
    config: { channels?: Record<string, unknown> };
    defaults?: unknown;
    context: unknown;
  }) => void;
}

/**
 * The subset of `openclaw/plugin-sdk/channel-secret-basic-runtime` this
 * plugin needs. Declared locally because the repo's dev dependency is an
 * older SDK whose type declarations predate this helper.
 */
export interface WebexChannelSecretSdk {
  createSimpleChannelSecretContract?: (params: {
    channelKey: string;
    label: string;
    accountFields: readonly string[];
    channelFields: readonly string[];
    mode: "account-inheritance" | "channel-surface" | "channel-only";
  }) => WebexChannelSecretContract;
}

/**
 * Builds the Webex contract with "account-inheritance" semantics, which
 * match resolveWebexAccount(): an account's own field wins; a top-level
 * field is active only if some enabled account inherits it (or there are
 * no named accounts and the channel is enabled). Refs on disabled
 * accounts are reported as inactive and never resolved.
 */
export function createWebexChannelSecrets(
  sdk: WebexChannelSecretSdk
): WebexChannelSecretContract {
  if (typeof sdk.createSimpleChannelSecretContract !== "function") {
    throw new Error(
      "openclaw/plugin-sdk/channel-secret-basic-runtime does not export " +
        "createSimpleChannelSecretContract; Webex SecretRef support requires " +
        "OpenClaw 2026.10 or newer."
    );
  }
  return sdk.createSimpleChannelSecretContract({
    channelKey: WEBEX_CHANNEL_KEY,
    label: "Webex",
    accountFields: WEBEX_SECRET_FIELDS,
    channelFields: WEBEX_SECRET_FIELDS,
    mode: "account-inheritance",
  });
}
