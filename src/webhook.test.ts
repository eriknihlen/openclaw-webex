/**
 * Regression tests for stripping the bot's leading @mention in group spaces.
 *
 * Background (2026-10-20): "@Marcus /new" in the AIOps space reached the
 * agent as the prompt "Marcus /new" instead of resetting the session. The
 * Webex client sent a malformed data-object-id whose base64 also swallowed
 * the next attribute, so the exact-match check never recognised the bot and
 * the label was left in front of the command. /goal and every other slash
 * command were affected the same way.
 */
import { describe, expect, it } from "vitest";
import { WebexWebhookHandler } from "./webhook";
import type { WebexMessage } from "./types";

const BOT_UUID = "727e7945-31f6-4663-a7f0-a7165451f70b";
const BOT_ID = Buffer.from(`ciscospark://us/PEOPLE/${BOT_UUID}`).toString("base64").replace(/=+$/, "");
const OTHER_UUID = "11111111-2222-3333-4444-555555555555";

function b64(s: string): string {
  return Buffer.from(s).toString("base64").replace(/=+$/, "");
}

function handler(): WebexWebhookHandler {
  const h = new WebexWebhookHandler({ token: "x" } as never);
  (h as unknown as { botId: string }).botId = BOT_ID;
  return h;
}

function strip(message: Partial<WebexMessage>): WebexMessage {
  const base = { id: "m", roomId: "r", roomType: "group", personId: "p", personEmail: "e", created: "" };
  return (handler() as unknown as { stripLeadingBotMention(m: WebexMessage): WebexMessage })
    .stripLeadingBotMention({ ...base, ...message } as WebexMessage);
}

function mention(objectId: string, label = "Marcus"): string {
  return `<spark-mention data-object-type="person" data-object-id="${objectId}">${label}</spark-mention>`;
}

describe("stripLeadingBotMention", () => {
  it("strips the mention when the client sends a malformed object id (real 2026-10-20 message)", () => {
    const malformed = b64(`ciscospark://us/PEOPLE/${BOT_UUID}" data-mention-origin="client`);
    const out = strip({ text: "Marcus /new", html: `<p>${mention(malformed)} /new</p>` });
    expect(out.text).toBe("/new");
  });

  it("strips the mention for a well-formed object id", () => {
    const out = strip({ text: "Marcus /goal status", html: `<p>${mention(BOT_ID)} /goal status</p>` });
    expect(out.text).toBe("/goal status");
  });

  it("leaves a leading mention of someone else untouched", () => {
    const other = b64(`ciscospark://us/PEOPLE/${OTHER_UUID}" data-mention-origin="client`);
    const out = strip({ text: "Gunnar /new", html: `<p>${mention(other, "Gunnar")} /new</p>` });
    expect(out.text).toBe("Gunnar /new");
  });

  it("leaves a mid-sentence mention of the bot untouched", () => {
    const out = strip({ text: "ask Marcus later", html: `<p>ask ${mention(BOT_ID)} later</p>` });
    expect(out.text).toBe("ask Marcus later");
  });
});
