"use strict";
/**
 * OpenClaw Webex Channel Plugin
 *
 * A channel plugin for integrating Cisco Webex messaging with OpenClaw.
 *
 * @packageDocumentation
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WEBEX_SAFE_CHUNK_BYTES = exports.WEBEX_TEXT_LIMIT_BYTES = exports.trimToSafeMarkdownBoundary = exports.transformMarkdownForWebex = exports.stripMarkdownSyntax = exports.splitForWebex = exports.looksMarkdown = exports.mentionMarkdown = exports.escapeMarkdown = exports.validateForWebex = exports.approvalCard = exports.statusCard = exports.factCard = exports.webexPlugin = exports.createAndInitialize = exports.createWebexChannel = exports.WebexChannel = exports.WebhookValidationError = exports.WebexWebhookHandler = exports.WebexApiRequestError = exports.WebexSender = exports.id = exports.default = void 0;
// Re-export the plugin registration function as default
var plugin_1 = require("./plugin");
Object.defineProperty(exports, "default", { enumerable: true, get: function () { return __importDefault(plugin_1).default; } });
var plugin_2 = require("./plugin");
Object.defineProperty(exports, "id", { enumerable: true, get: function () { return plugin_2.id; } });
// Re-export existing classes for backwards compatibility and advanced usage
var send_1 = require("./send");
Object.defineProperty(exports, "WebexSender", { enumerable: true, get: function () { return send_1.WebexSender; } });
Object.defineProperty(exports, "WebexApiRequestError", { enumerable: true, get: function () { return send_1.WebexApiRequestError; } });
var webhook_1 = require("./webhook");
Object.defineProperty(exports, "WebexWebhookHandler", { enumerable: true, get: function () { return webhook_1.WebexWebhookHandler; } });
Object.defineProperty(exports, "WebhookValidationError", { enumerable: true, get: function () { return webhook_1.WebhookValidationError; } });
var channel_1 = require("./channel");
Object.defineProperty(exports, "WebexChannel", { enumerable: true, get: function () { return channel_1.WebexChannel; } });
Object.defineProperty(exports, "createWebexChannel", { enumerable: true, get: function () { return channel_1.createWebexChannel; } });
Object.defineProperty(exports, "createAndInitialize", { enumerable: true, get: function () { return channel_1.createAndInitialize; } });
var channel_plugin_1 = require("./channel-plugin");
Object.defineProperty(exports, "webexPlugin", { enumerable: true, get: function () { return channel_plugin_1.webexPlugin; } });
// AdaptiveCards builders (tier-3): factCard, statusCard, approvalCard,
// validateForWebex. Shipped so skills / agent code can emit structured
// replies without hand-rolling the schema each time.
var card_builder_1 = require("./card-builder");
Object.defineProperty(exports, "factCard", { enumerable: true, get: function () { return card_builder_1.factCard; } });
Object.defineProperty(exports, "statusCard", { enumerable: true, get: function () { return card_builder_1.statusCard; } });
Object.defineProperty(exports, "approvalCard", { enumerable: true, get: function () { return card_builder_1.approvalCard; } });
Object.defineProperty(exports, "validateForWebex", { enumerable: true, get: function () { return card_builder_1.validateForWebex; } });
// Formatter helpers (tier-1/2): useful for skills that want to pre-shape
// markdown before handing off to the agent reply pipeline.
var formatters_1 = require("./formatters");
Object.defineProperty(exports, "escapeMarkdown", { enumerable: true, get: function () { return formatters_1.escapeMarkdown; } });
Object.defineProperty(exports, "mentionMarkdown", { enumerable: true, get: function () { return formatters_1.mentionMarkdown; } });
Object.defineProperty(exports, "looksMarkdown", { enumerable: true, get: function () { return formatters_1.looksMarkdown; } });
Object.defineProperty(exports, "splitForWebex", { enumerable: true, get: function () { return formatters_1.splitForWebex; } });
Object.defineProperty(exports, "stripMarkdownSyntax", { enumerable: true, get: function () { return formatters_1.stripMarkdownSyntax; } });
Object.defineProperty(exports, "transformMarkdownForWebex", { enumerable: true, get: function () { return formatters_1.transformMarkdownForWebex; } });
Object.defineProperty(exports, "trimToSafeMarkdownBoundary", { enumerable: true, get: function () { return formatters_1.trimToSafeMarkdownBoundary; } });
Object.defineProperty(exports, "WEBEX_TEXT_LIMIT_BYTES", { enumerable: true, get: function () { return formatters_1.WEBEX_TEXT_LIMIT_BYTES; } });
Object.defineProperty(exports, "WEBEX_SAFE_CHUNK_BYTES", { enumerable: true, get: function () { return formatters_1.WEBEX_SAFE_CHUNK_BYTES; } });
//# sourceMappingURL=index.js.map