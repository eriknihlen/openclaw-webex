"use strict";
/**
 * OpenClaw Webex Channel Plugin
 *
 * Main entry point for the OpenClaw plugin system.
 * Exports a default function that registers the Webex channel.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.id = void 0;
exports.default = register;
const channel_plugin_1 = require("./channel-plugin");
/**
 * OpenClaw plugin registration function.
 *
 * This is the entry point that OpenClaw calls when loading the plugin.
 * It registers the Webex channel with the plugin system.
 */
function register(api) {
    // Store the plugin runtime for use in HTTP handlers
    (0, channel_plugin_1.setPluginRuntime)(api.runtime);
    api.registerChannel({ plugin: channel_plugin_1.webexPlugin });
    // OpenClaw removed registerHttpHandler in favor of registerHttpRoute.
    // We own the /webhooks/webex/* prefix and verify auth ourselves via the
    // Webex webhook signature, so auth is "plugin". Cast is required because
    // the locally pinned openclaw type defs predate registerHttpRoute.
    api.registerHttpRoute({
        path: "/webhooks/webex/",
        match: "prefix",
        auth: "plugin",
        handler: (0, channel_plugin_1.createWebhookHandler)(),
    });
}
// Export the plugin ID for reference
exports.id = "webex";
//# sourceMappingURL=plugin.js.map