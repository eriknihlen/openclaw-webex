/**
 * OpenClaw Webex Channel Plugin
 *
 * A channel plugin for integrating Cisco Webex messaging with OpenClaw.
 *
 * @packageDocumentation
 */

// Re-export the plugin registration function as default
export { default } from "./plugin";
export { id } from "./plugin";

// Re-export existing classes for backwards compatibility and advanced usage
export { WebexSender, WebexApiRequestError } from "./send";
export { WebexWebhookHandler, WebhookValidationError } from "./webhook";
export type { AttachmentActionEvent } from "./webhook";
export { WebexChannel, createWebexChannel, createAndInitialize } from "./channel";
export { webexPlugin } from "./channel-plugin";

// AdaptiveCards builders (tier-3): factCard, statusCard, approvalCard,
// validateForWebex. Shipped so skills / agent code can emit structured
// replies without hand-rolling the schema each time.
export {
  factCard,
  statusCard,
  approvalCard,
  validateForWebex,
} from "./card-builder";
export type { CardAction, StatusLevel } from "./card-builder";

// Formatter helpers (tier-1/2): useful for skills that want to pre-shape
// markdown before handing off to the agent reply pipeline.
export {
  escapeMarkdown,
  mentionMarkdown,
  looksMarkdown,
  splitForWebex,
  stripMarkdownSyntax,
  transformMarkdownForWebex,
  trimToSafeMarkdownBoundary,
  WEBEX_TEXT_LIMIT_BYTES,
  WEBEX_SAFE_CHUNK_BYTES,
} from "./formatters";

// Re-export types
export type {
  WebexChannelConfig,
  DmPolicy,
  WebexPerson,
  WebexRoom,
  WebexMessage,
  WebexAttachment,
  AdaptiveCard,
  WebexWebhook,
  WebexWebhookResource,
  WebexWebhookEvent,
  WebexWebhookPayload,
  WebexWebhookData,
  CreateMessageRequest,
  CreateWebhookRequest,
  WebexApiError,
  PaginatedResponse,
  OpenClawEnvelope,
  OpenClawAttachment,
  OpenClawOutboundMessage,
  WebexChannelPlugin,
  WebhookHandler,
  RetryOptions,
  RequestOptions,
} from "./types";

export type { ResolvedWebexAccount } from "./channel-plugin";
