/**
 * Webex Channel Plugin Types
 */
export type DmPolicy = 'allow' | 'deny' | 'allowlisted' | 'allowlist' | 'pairing';
export interface WebexChannelConfig {
    /** Webex Bot access token */
    token: string;
    /** Policy for handling direct messages */
    dmPolicy: DmPolicy;
    /** List of allowed person IDs or emails (used when dmPolicy is 'allowlisted') */
    allowFrom?: string[];
    /** Base URL for Webex API (defaults to https://webexapis.com/v1) */
    apiBaseUrl?: string;
    /** Maximum retry attempts for failed requests */
    maxRetries?: number;
    /** Retry delay in milliseconds */
    retryDelayMs?: number;
    /**
     * When true (default), post a short "working…" placeholder message as soon
     * as a webhook arrives, then delete it once the real reply is sent. Webex
     * has no edit API for text messages, so this is the best proxy for a
     * typing / progress indicator.
     */
    showProgressPlaceholder?: boolean;
    /** Text used for the placeholder message (defaults to "⏳ Working on it…") */
    progressPlaceholderText?: string;
    /**
     * Controls how chatty the live progress indicator is.
     *
     * - "silent": no progress messages at all (same as showProgressPlaceholder=false).
     * - "minimal": only the initial placeholder (defaults to "⏳ Working on it…");
     *   it stays there until the real reply replaces it.
     * - "detailed" (default): also posts thinking / tool / command / plan /
     *   approval / writing transitions as the agent works.
     *
     * Has no effect when `showProgressPlaceholder` is false.
     */
    progressVerbosity?: "silent" | "minimal" | "detailed";
    /**
     * Periodic heartbeat interval (ms) that refreshes the progress message
     * even when no agent events fire — so the user can see the bot is still
     * working on long-running tasks. Default 300000 (5 minutes). Set to 0
     * to disable.
     *
     * Ignored when progressVerbosity is "silent".
     */
    progressHeartbeatMs?: number;
    /**
     * OpenClaw agent id this account dispatches to. When unset, defaults
     * to "main". Enables multi-agent deployments where multiple Webex
     * bots on the same gateway route to different agent ids.
     */
    agent?: string;
    /**
     * Stream the agent's reasoning / thinking text live into the Webex
     * progress message, instead of the static "Thinking…" label.
     * Default false. Opt-in because raw reasoning occasionally contains
     * internal deliberation or echoed context users didn't intend to see
     * in chat — redaction is best-effort, not comprehensive.
     */
    progressStreamReasoning?: boolean;
    /**
     * Base URL for the AIOps dashboard's approval API, used to record
     * approve/reject decisions submitted from AIOps approval cards
     * (Action.Submit data `{intent: "aiops-approval", evalId, decision}`).
     * Defaults to "http://127.0.0.1:8765/api/v1".
     */
    aiopsApprovalUrl?: string;
    /**
     * Optional shared secret sent as the `X-AIOps-Approval-Secret` header
     * on every approval/rejection POST to the AIOps dashboard. Never
     * logged. Unset means no secret header is sent.
     */
    aiopsApprovalSecret?: string;
    /**
     * Allowed root directories for outbound local file sends (see
     * outbound-file-guard.ts's resolveAllowedOutboundFile). A local path
     * must canonicalize to somewhere inside one of these roots — and pass
     * the extension allowlist and deny-list enforced alongside it — to be
     * eligible for upload via WebexSender.sendLocalFile. When unset,
     * defaults to <stateDir>/workspace/outbound, <stateDir>/media/outbound
     * and /tmp, where stateDir is OPENCLAW_STATE_DIR ?? ~/.openclaw (no
     * hardcoded host paths). Deliberately NOT the workspace root itself, which also holds live
     * secrets (credential files, memory .bak snapshots, etc).
     */
    outboundFileRoots?: string[];
    /**
     * When a chunked reply would split into this many Webex messages or
     * more, send it instead as a single message with the full reply
     * attached as a markdown file (see deliverChunked in
     * channel-plugin.ts). Default 4. Set to 0 to disable and always send
     * chunked text.
     */
    longReplyAttachThreshold?: number;
}
export interface WebexPerson {
    id: string;
    emails: string[];
    displayName: string;
    nickName?: string;
    firstName?: string;
    lastName?: string;
    avatar?: string;
    orgId: string;
    created: string;
    lastModified?: string;
    type: 'person' | 'bot';
}
export interface WebexRoom {
    id: string;
    title: string;
    type: 'direct' | 'group';
    isLocked: boolean;
    teamId?: string;
    lastActivity: string;
    creatorId: string;
    created: string;
    ownerId?: string;
}
export interface WebexMessage {
    id: string;
    roomId: string;
    roomType: 'direct' | 'group';
    toPersonId?: string;
    toPersonEmail?: string;
    text?: string;
    markdown?: string;
    html?: string;
    files?: string[];
    personId: string;
    personEmail: string;
    mentionedPeople?: string[];
    mentionedGroups?: string[];
    attachments?: WebexAttachment[];
    created: string;
    updated?: string;
    parentId?: string;
}
export interface WebexAttachment {
    contentType: 'application/vnd.microsoft.card.adaptive';
    content: AdaptiveCard;
}
export interface AdaptiveCard {
    type: 'AdaptiveCard';
    version: string;
    body: unknown[];
    actions?: unknown[];
}
export type WebexWebhookResource = 'messages' | 'memberships' | 'rooms' | 'attachmentActions' | 'meetings' | 'recordings';
export type WebexWebhookEvent = 'created' | 'updated' | 'deleted' | 'started' | 'ended';
export interface WebexWebhookPayload {
    id: string;
    name: string;
    targetUrl: string;
    resource: WebexWebhookResource;
    event: WebexWebhookEvent;
    filter?: string;
    orgId: string;
    createdBy: string;
    appId: string;
    ownedBy: string;
    status: string;
    created: string;
    actorId: string;
    data: WebexWebhookData;
}
export interface WebexWebhookData {
    id: string;
    roomId: string;
    roomType: 'direct' | 'group';
    personId: string;
    personEmail: string;
    created: string;
    mentionedPeople?: string[];
    mentionedGroups?: string[];
    files?: string[];
}
export interface CreateMessageRequest {
    roomId?: string;
    toPersonId?: string;
    toPersonEmail?: string;
    text?: string;
    markdown?: string;
    files?: string[];
    attachments?: WebexAttachment[];
    parentId?: string;
}
export interface WebexApiError {
    message: string;
    errors?: Array<{
        description: string;
    }>;
    trackingId: string;
}
export interface PaginatedResponse<T> {
    items: T[];
}
export interface OpenClawEnvelope {
    /** Unique message identifier */
    id: string;
    /** Channel identifier */
    channel: 'webex';
    /** Conversation/thread identifier */
    conversationId: string;
    /** Message author information */
    author: {
        id: string;
        email?: string;
        displayName?: string;
        isBot: boolean;
    };
    /** Message content */
    content: {
        text?: string;
        markdown?: string;
        attachments?: OpenClawAttachment[];
    };
    /** Message metadata */
    metadata: {
        roomType: 'direct' | 'group';
        roomId: string;
        timestamp: string;
        mentions?: string[];
        parentId?: string;
        raw: WebexMessage;
    };
}
export interface OpenClawAttachment {
    type: 'file' | 'card';
    url?: string;
    content?: unknown;
    /** Filename parsed from Content-Disposition, if available */
    name?: string;
    /** MIME type returned by the origin */
    contentType?: string;
    /** Byte size of the downloaded payload */
    size?: number;
    /** Absolute path to the downloaded file on disk */
    localPath?: string;
}
export interface OpenClawOutboundMessage {
    /** Target conversation ID (roomId) or person ID/email for DMs */
    to: string;
    /** Message content */
    content: {
        text?: string;
        markdown?: string;
        files?: string[];
        card?: AdaptiveCard;
    };
    /** Optional parent message ID for threading */
    parentId?: string;
}
export interface WebexChannelPlugin {
    name: string;
    version: string;
    /** Initialize the channel with configuration */
    initialize(config: WebexChannelConfig): Promise<void>;
    /** Send a message */
    send(message: OpenClawOutboundMessage): Promise<WebexMessage>;
    /** Handle incoming webhook */
    handleWebhook(payload: WebexWebhookPayload, signature?: string): Promise<OpenClawEnvelope | null>;
    /** Register webhooks with Webex */
    /** Cleanup and shutdown */
    shutdown(): Promise<void>;
}
export interface WebhookHandler {
    (envelope: OpenClawEnvelope): Promise<void> | void;
}
export interface RetryOptions {
    maxRetries: number;
    retryDelayMs: number;
    shouldRetry?: (error: Error, attempt: number) => boolean;
}
export interface RequestOptions {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
    /**
     * Per-call override of the sender's configured retry budget. Used by
     * callers on a latency-sensitive path (e.g. a best-effort pre-dispatch
     * check) that would rather fail fast than inherit the full retry/backoff
     * budget meant for outbound message delivery.
     */
    maxRetries?: number;
}
