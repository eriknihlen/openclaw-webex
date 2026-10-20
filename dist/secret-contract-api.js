"use strict";
/**
 * Channel secret contract artifact loaded by the OpenClaw host.
 *
 * Compiles to dist/secret-contract-api.js, the conventional path the host
 * probes for external channel plugins (see secret-contract.ts). Keep this
 * module import-light: the host loads it in read-only command paths
 * (`secrets audit`, `channels status`) and at gateway startup before the
 * channel runtime starts. It must not start clients or read secrets.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectRuntimeConfigAssignments = exports.secretTargetRegistryEntries = exports.channelSecrets = void 0;
const secret_contract_1 = require("./secret-contract");
// require(), not import: this package compiles to CommonJS while the SDK
// subpath is ESM. The host's plugin module loader aliases
// `openclaw/plugin-sdk/*` to the running host's SDK.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sdk = require("openclaw/plugin-sdk/channel-secret-basic-runtime");
exports.channelSecrets = (0, secret_contract_1.createWebexChannelSecrets)(sdk);
exports.secretTargetRegistryEntries = exports.channelSecrets.secretTargetRegistryEntries;
exports.collectRuntimeConfigAssignments = exports.channelSecrets.collectRuntimeConfigAssignments;
//# sourceMappingURL=secret-contract-api.js.map