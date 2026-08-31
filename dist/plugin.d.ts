/**
 * OpenClaw Webex Channel Plugin
 *
 * Main entry point for the OpenClaw plugin system.
 * Exports a default function that registers the Webex channel.
 *
 * Inbound events arrive exclusively over the Mercury websocket transport
 * (see websocket.ts) — an outbound wss:// connection to Webex. The plugin
 * registers no HTTP routes: there is no inbound endpoint, no public URL,
 * and no webhook signature to verify. (Webhook transport was removed
 * 2026-08-31 after the websocket transport was verified in production.)
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk" with { "resolution-mode": "import" };
/**
 * OpenClaw plugin registration function.
 *
 * This is the entry point that OpenClaw calls when loading the plugin.
 * It registers the Webex channel with the plugin system.
 */
export default function register(api: OpenClawPluginApi): void;
export declare const id = "webex";
