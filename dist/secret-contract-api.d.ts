/**
 * Channel secret contract artifact loaded by the OpenClaw host.
 *
 * Compiles to dist/secret-contract-api.js, the conventional path the host
 * probes for external channel plugins (see secret-contract.ts). Keep this
 * module import-light: the host loads it in read-only command paths
 * (`secrets audit`, `channels status`) and at gateway startup before the
 * channel runtime starts. It must not start clients or read secrets.
 */
export declare const channelSecrets: import("./secret-contract").WebexChannelSecretContract;
export declare const secretTargetRegistryEntries: import("./secret-contract").WebexSecretTargetRegistryEntry[];
export declare const collectRuntimeConfigAssignments: (params: {
    config: {
        channels?: Record<string, unknown>;
    };
    defaults?: unknown;
    context: unknown;
}) => void;
