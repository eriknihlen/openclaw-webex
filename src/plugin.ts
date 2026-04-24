/**
 * OpenClaw Webex Channel Plugin
 *
 * Main entry point for the OpenClaw plugin system.
 * Exports a default function that registers the Webex channel.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk" with { "resolution-mode": "import" };
import { webexPlugin, createWebhookHandler, setPluginRuntime } from "./channel-plugin";

/**
 * OpenClaw plugin registration function.
 *
 * This is the entry point that OpenClaw calls when loading the plugin.
 * It registers the Webex channel with the plugin system.
 */
export default function register(api: OpenClawPluginApi): void {
  // Store the plugin runtime for use in HTTP handlers
  setPluginRuntime(api.runtime);

  api.registerChannel({ plugin: webexPlugin });

  // OpenClaw removed registerHttpHandler in favor of registerHttpRoute.
  // We own the /webhooks/webex/* prefix and verify auth ourselves via the
  // Webex webhook signature, so auth is "plugin". Cast is required because
  // the locally pinned openclaw type defs predate registerHttpRoute.
  (api as unknown as {
    registerHttpRoute: (params: {
      path: string;
      match?: "exact" | "prefix";
      auth: "gateway" | "plugin";
      handler: ReturnType<typeof createWebhookHandler>;
    }) => void;
  }).registerHttpRoute({
    path: "/webhooks/webex/",
    match: "prefix",
    auth: "plugin",
    handler: createWebhookHandler(),
  });
}

// Export the plugin ID for reference
export const id = "webex";
