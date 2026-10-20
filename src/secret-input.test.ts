/**
 * SecretRef-aware account resolution: plaintext tokens keep working,
 * gateway-resolved SecretRefs (which arrive as plain strings) are used
 * as-is, and an unresolved SecretRef object is never used as a
 * credential and never leaks its id into errors or logs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasWebexSecretInput,
  isWebexSecretRef,
  readWebexSecretString,
  unresolvedWebexSecretMessage,
  webexSecretStatus,
} from "./secret-input";
import { assertWebexTokenAvailable, resolveWebexAccount, webexPlugin } from "./channel-plugin";

const REF = { source: "store", provider: "teamstore", id: "MARCUS_WEBEX_BOT_TOKEN" };

describe("secret-input helpers", () => {
  it("classifies plaintext, SecretRef and missing values", () => {
    expect(webexSecretStatus("abc")).toBe("available");
    expect(webexSecretStatus("   ")).toBe("missing");
    expect(webexSecretStatus(undefined)).toBe("missing");
    expect(webexSecretStatus(null)).toBe("missing");
    expect(webexSecretStatus(REF)).toBe("configured_unavailable");
    expect(webexSecretStatus({ source: "env", id: "X" })).toBe("configured_unavailable");
    expect(webexSecretStatus({ foo: "bar" })).toBe("missing");
    expect(webexSecretStatus(["a"])).toBe("missing");
  });

  it("only ever returns strings as credentials", () => {
    expect(readWebexSecretString(" tok \n")).toBe("tok");
    expect(readWebexSecretString(REF)).toBeUndefined();
    expect(readWebexSecretString(42)).toBeUndefined();
    expect(readWebexSecretString("")).toBeUndefined();
  });

  it("recognises SecretRef objects", () => {
    expect(isWebexSecretRef(REF)).toBe(true);
    expect(isWebexSecretRef({ source: "store", provider: 1, id: "X" })).toBe(false);
    expect(isWebexSecretRef("store:X")).toBe(false);
    expect(hasWebexSecretInput(REF)).toBe(true);
    expect(hasWebexSecretInput("")).toBe(false);
  });

  it("unresolved message names the path, not the ref id", () => {
    const msg = unresolvedWebexSecretMessage("channels.webex.accounts.marcus.token");
    expect(msg).toContain("channels.webex.accounts.marcus.token");
    expect(msg).not.toContain(REF.id);
  });
});

describe("resolveWebexAccount with SecretRef inputs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("plaintext tokens still work (named account and top-level)", () => {
    const cfg = {
      channels: {
        webex: {
          token: "top-level-plain",
          aiopsApprovalSecret: "approval-plain",
          accounts: { marcus: { token: "marcus-plain", agent: "marcus" } },
        },
      },
    };
    const marcus = resolveWebexAccount({ cfg, accountId: "marcus" });
    expect(marcus.configured).toBe(true);
    expect(marcus.tokenStatus).toBe("available");
    expect(marcus.config.token).toBe("marcus-plain");
    expect(marcus.config.aiopsApprovalSecret).toBe("approval-plain");
    expect(() => assertWebexTokenAvailable(marcus)).not.toThrow();

    const def = resolveWebexAccount({ cfg, accountId: "default" });
    expect(def.config.token).toBe("top-level-plain");
    expect(def.tokenStatus).toBe("available");
  });

  it("uses the gateway-resolved string in place of the SecretRef", () => {
    // The gateway's secrets runtime replaces the ref object with the
    // resolved string before the plugin sees the runtime config.
    const resolvedCfg = {
      channels: {
        webex: {
          aiopsApprovalSecret: "resolved-approval",
          accounts: { marcus: { token: "resolved-marcus-token" } },
        },
      },
    };
    const marcus = resolveWebexAccount({ cfg: resolvedCfg, accountId: "marcus" });
    expect(marcus.config.token).toBe("resolved-marcus-token");
    expect(marcus.token).toBe("resolved-marcus-token");
    expect(marcus.config.aiopsApprovalSecret).toBe("resolved-approval");
    expect(() => assertWebexTokenAvailable(marcus)).not.toThrow();
  });

  it("an unresolved SecretRef is configured but never used as a credential", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cfg = {
      channels: {
        webex: {
          aiopsApprovalSecret: { source: "store", provider: "teamstore", id: "AIOPS_APPROVAL_SECRET" },
          accounts: { marcus: { token: REF } },
        },
      },
    };
    const marcus = resolveWebexAccount({ cfg: cfg as any, accountId: "marcus" });
    expect(marcus.configured).toBe(true);
    expect(marcus.tokenStatus).toBe("configured_unavailable");
    expect(marcus.token).toBeUndefined();
    expect(marcus.config.token).toBe("");
    expect(marcus.config.aiopsApprovalSecret).toBeUndefined();

    expect(() => assertWebexTokenAvailable(marcus)).toThrow(
      /channels\.webex\.accounts\.marcus\.token is a SecretRef/
    );
    try {
      assertWebexTokenAvailable(marcus);
    } catch (err) {
      expect(String(err)).not.toContain(REF.id);
      expect(String(err)).not.toContain("[object Object]");
    }

    // Warned once, by path, without the ref id.
    resolveWebexAccount({ cfg: cfg as any, accountId: "marcus" });
    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("channels.webex.aiopsApprovalSecret");
    expect(logged).not.toContain("AIOPS_APPROVAL_SECRET");
  });

  it("an account-level SecretRef overrides the inherited top-level token", () => {
    const cfg = {
      channels: { webex: { token: "top-level-plain", accounts: { marcus: { token: REF } } } },
    };
    const marcus = resolveWebexAccount({ cfg: cfg as any, accountId: "marcus" });
    expect(marcus.tokenStatus).toBe("configured_unavailable");
    expect(marcus.config.token).toBe("");
    expect(marcus.tokenPath).toBe("channels.webex.accounts.marcus.token");
  });

  it("top-level SecretRef token is reported against channels.webex.token", () => {
    const cfg = { channels: { webex: { token: REF } } };
    const def = resolveWebexAccount({ cfg: cfg as any, accountId: "default" });
    expect(def.configured).toBe(true);
    expect(def.tokenStatus).toBe("configured_unavailable");
    expect(() => assertWebexTokenAvailable(def)).toThrow(/channels\.webex\.token is a SecretRef/);
  });

  it("missing token is not configured", () => {
    const def = resolveWebexAccount({ cfg: { channels: { webex: {} } }, accountId: "default" });
    expect(def.configured).toBe(false);
    expect(def.tokenStatus).toBe("missing");
  });

  it("startAccount refuses to connect with an unresolved SecretRef", async () => {
    const account = resolveWebexAccount({
      cfg: { channels: { webex: { accounts: { marcus: { token: REF } } } } } as any,
      accountId: "marcus",
    });
    const setStatus = vi.fn();
    await expect(
      webexPlugin.gateway!.startAccount!({ account, setStatus, log: undefined } as any)
    ).rejects.toThrow(/SecretRef/);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("outbound sendText refuses to send with an unresolved SecretRef", async () => {
    await expect(
      (webexPlugin.outbound as any).sendText({
        cfg: { channels: { webex: { accounts: { marcus: { token: REF } } } } },
        accountId: "marcus",
        to: "someone@example.com",
        text: "hi",
      })
    ).rejects.toThrow(/SecretRef/);
  });
});
