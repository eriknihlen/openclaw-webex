/**
 * Channel secret contract artifact loaded by the OpenClaw host.
 *
 * Compiles to dist/secret-contract-api.js, the conventional path the host
 * probes for external channel plugins (see secret-contract.ts). Keep this
 * module import-light: the host loads it in read-only command paths
 * (`secrets audit`, `channels status`) and at gateway startup before the
 * channel runtime starts. It must not start clients or read secrets.
 */

import {
  createWebexChannelSecrets,
  type WebexChannelSecretSdk,
} from "./secret-contract";

// require(), not import: this package compiles to CommonJS while the SDK
// subpath is ESM. The host's plugin module loader aliases
// `openclaw/plugin-sdk/*` to the running host's SDK.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sdk: WebexChannelSecretSdk = require("openclaw/plugin-sdk/channel-secret-basic-runtime");

export const channelSecrets = createWebexChannelSecrets(sdk);
export const secretTargetRegistryEntries = channelSecrets.secretTargetRegistryEntries;
export const collectRuntimeConfigAssignments =
  channelSecrets.collectRuntimeConfigAssignments;
