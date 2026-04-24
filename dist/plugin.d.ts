/**
 * OpenClaw Webex Channel Plugin
 *
 * Main entry point for the OpenClaw plugin system.
 * Exports a default function that registers the Webex channel.
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
