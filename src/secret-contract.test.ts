/**
 * Channel secret contract + manifest schema.
 *
 * The fake-SDK tests always run. The host-integration tests run against
 * the installed OpenClaw (the real createSimpleChannelSecretContract and
 * the host's ajv) when it is present, and are skipped otherwise; set
 * OPENCLAW_HOST_DIR to point at a different install.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createWebexChannelSecrets,
  WEBEX_SECRET_FIELDS,
  type WebexChannelSecretSdk,
} from "./secret-contract";

const HOST_DIR =
  process.env.OPENCLAW_HOST_DIR ??
  "/home/claw/.openclaw/tools/node-v24.19.0/lib/node_modules/openclaw";
const HOST_SDK = path.join(HOST_DIR, "dist/plugin-sdk/channel-secret-basic-runtime.js");
const HOST_AJV = path.join(HOST_DIR, "node_modules/ajv");
const hasHostSdk = fs.existsSync(HOST_SDK);
const hasHostAjv = fs.existsSync(HOST_AJV);

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "openclaw.plugin.json"), "utf8")
);

const STORE_REF = { source: "store", provider: "teamstore", id: "MARCUS_WEBEX_BOT_TOKEN" };
const ENV_REF = { source: "env", provider: "default", id: "WEBEX_TEST_TOKEN" };

describe("createWebexChannelSecrets", () => {
  it("declares token and aiopsApprovalSecret at channel and account scope", () => {
    const fake = {
      createSimpleChannelSecretContract: vi.fn(() => ({
        secretTargetRegistryEntries: [],
        collectRuntimeConfigAssignments: () => {},
      })),
    } satisfies WebexChannelSecretSdk;
    createWebexChannelSecrets(fake);
    expect(fake.createSimpleChannelSecretContract).toHaveBeenCalledWith({
      channelKey: "webex",
      label: "Webex",
      accountFields: WEBEX_SECRET_FIELDS,
      channelFields: WEBEX_SECRET_FIELDS,
      mode: "account-inheritance",
    });
  });

  it("fails loudly on a host SDK without the helper", () => {
    expect(() => createWebexChannelSecrets({})).toThrow(/OpenClaw 2026\.10/);
  });
});

describe.skipIf(!hasHostSdk)("contract against the installed OpenClaw SDK", () => {
  async function loadContract() {
    const sdk = await import(pathToFileURL(HOST_SDK).href);
    return createWebexChannelSecrets(sdk);
  }

  function resolverContext(sourceConfig: unknown) {
    return {
      sourceConfig,
      env: {},
      cache: {},
      warnings: [] as Array<{ code: string; path: string }>,
      warningKeys: new Set<string>(),
      assignments: [] as Array<{ path: string; ref: unknown; apply: (v: unknown) => void }>,
    };
  }

  it("registers the four openclaw.json target paths", async () => {
    const contract = await loadContract();
    expect(contract.secretTargetRegistryEntries.map((e) => e.pathPattern).sort()).toEqual([
      "channels.webex.accounts.*.aiopsApprovalSecret",
      "channels.webex.accounts.*.token",
      "channels.webex.aiopsApprovalSecret",
      "channels.webex.token",
    ]);
    for (const entry of contract.secretTargetRegistryEntries) {
      expect(entry.configFile).toBe("openclaw.json");
      expect(entry.expectedResolvedValue).toBe("string");
      expect(entry.includeInAudit).toBe(true);
    }
  });

  it("collects active refs, skips disabled accounts, and applies resolved strings", async () => {
    const contract = await loadContract();
    const config = {
      channels: {
        webex: {
          enabled: true,
          aiopsApprovalSecret: { ...STORE_REF, id: "AIOPS_APPROVAL_SECRET" },
          accounts: {
            marcus: { enabled: true, token: STORE_REF },
            default: { token: "plaintext-token" },
            "captain-kacper": { enabled: false, token: { ...STORE_REF, id: "KACPER_TOKEN" } },
          },
        },
      },
    };
    const context = resolverContext(structuredClone(config));
    contract.collectRuntimeConfigAssignments({ config, context });

    const paths = context.assignments.map((a) => a.path).sort();
    // The top-level secret is inherited by both enabled accounts, so it is
    // collected once per owner.
    expect(new Set(paths)).toEqual(
      new Set(["channels.webex.accounts.marcus.token", "channels.webex.aiopsApprovalSecret"])
    );
    expect(context.warnings.map((w) => w.path)).toContain(
      "channels.webex.accounts.captain-kacper.token"
    );

    // Simulate the host applying resolved values.
    for (const a of context.assignments) {
      a.apply(a.path.endsWith(".token") ? "resolved-token" : "resolved-approval");
    }
    expect(config.channels.webex.accounts.marcus.token).toBe("resolved-token");
    expect(config.channels.webex.aiopsApprovalSecret).toBe("resolved-approval");
    expect(config.channels.webex.accounts.default.token).toBe("plaintext-token");
    expect(typeof config.channels.webex.accounts["captain-kacper"].token).toBe("object");
  });

  it("collects a top-level token when there are no named accounts", async () => {
    const contract = await loadContract();
    const config = { channels: { webex: { token: ENV_REF } } };
    const context = resolverContext(structuredClone(config));
    contract.collectRuntimeConfigAssignments({ config, context });
    expect(context.assignments.map((a) => a.path)).toEqual(["channels.webex.token"]);
  });
});

describe("manifest schema accepts SecretRefs", () => {
  const channelSchema = manifest.channelConfigs.webex.schema;
  const accountProps = channelSchema.properties.accounts.additionalProperties.properties;

  it("token and aiopsApprovalSecret allow string or SecretRef at every level", () => {
    const schemas = [
      channelSchema.properties,
      accountProps,
      manifest.configSchema.properties,
      manifest.configSchema.properties.accounts.additionalProperties.properties,
    ];
    for (const props of schemas) {
      for (const field of WEBEX_SECRET_FIELDS) {
        expect(props[field].anyOf[0]).toEqual({ type: "string" });
        expect(props[field].anyOf[1].oneOf.map((s: any) => s.properties.source.const)).toEqual([
          "env",
          "store",
          "file",
          "exec",
        ]);
      }
    }
  });

  it("plugin entry config no longer requires a plaintext token", () => {
    expect(manifest.configSchema.anyOf).toBeUndefined();
    expect(manifest.configContracts.secretInputs.paths.map((p: any) => p.path)).toEqual([
      "token",
      "aiopsApprovalSecret",
      "accounts.*.token",
      "accounts.*.aiopsApprovalSecret",
    ]);
  });

  describe.skipIf(!hasHostAjv)("validated with ajv", () => {
    const require = createRequire(__filename);
    const Ajv = require(HOST_AJV);
    const AjvCtor = Ajv.default ?? Ajv;
    const validate = new AjvCtor({ allErrors: true, strict: false }).compile(channelSchema);
    const validateEntry = new AjvCtor({ allErrors: true, strict: false }).compile(
      manifest.configSchema
    );

    it("accepts plaintext tokens", () => {
      expect(
        validate({ enabled: true, accounts: { marcus: { token: "plain", agent: "marcus" } } })
      ).toBe(true);
      expect(validate({ token: "plain", aiopsApprovalSecret: "s" })).toBe(true);
    });

    it("accepts SecretRef tokens and approval secrets", () => {
      expect(
        validate({
          enabled: true,
          aiopsApprovalSecret: { ...STORE_REF, id: "AIOPS_APPROVAL_SECRET" },
          accounts: {
            marcus: { enabled: true, token: STORE_REF },
            default: { token: ENV_REF, aiopsApprovalSecret: ENV_REF },
            "captain-kacper": { enabled: false, token: "plain" },
          },
        })
      ).toBe(true);
      expect(validate({ token: STORE_REF })).toBe(true);
    });

    it("rejects malformed refs and accounts without a token", () => {
      expect(validate({ accounts: { marcus: { token: { source: "store", id: "x" } } } })).toBe(
        false
      );
      expect(validate({ accounts: { marcus: { token: { ...STORE_REF, extra: 1 } } } })).toBe(false);
      expect(validate({ accounts: { marcus: { token: 42 } } })).toBe(false);
      expect(validate({ accounts: { marcus: { agent: "x" } } })).toBe(false);
    });

    it("accepts an empty plugin entry config", () => {
      expect(validateEntry({})).toBe(true);
      expect(validateEntry({ token: STORE_REF })).toBe(true);
    });
  });
});
