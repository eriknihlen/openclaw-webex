/**
 * AdaptiveCards builder helpers for Webex.
 *
 * Webex supports up to AdaptiveCards 1.3 with a handful of gotchas:
 *   - one card per message
 *   - no `Media`, no `Action.Execute`, no `height` on ColumnSet
 *   - up to 20 actions at the top level (use ActionSet to nest more)
 *   - cards with images cannot be edited via PUT /messages/{id}
 *
 * The templates in this module aim at the card shapes we'll actually
 * use from the agents:
 *   - factCard — PM report rows, inventory summaries, device status
 *   - statusCard — coloured traffic-light health readouts
 *   - approvalCard — two-button approve/deny with optional notes
 *
 * Every card emitted here targets schema `1.3` and only uses elements
 * / actions that Webex will accept (otherwise POST /messages returns
 * HTTP 400 from Webex's validator).
 *
 */
import type { AdaptiveCard } from "./types";
/**
 * A Webex-compatible card action. Action.Submit carries arbitrary
 * `data` that is echoed back on the attachment-actions webhook; we
 * use that channel to route submissions back to the originating
 * agent session (see channel-plugin dispatchAttachmentAction).
 */
export type CardAction = {
    type: "Action.OpenUrl";
    title: string;
    url: string;
} | {
    type: "Action.Submit";
    title: string;
    style?: "positive" | "destructive" | "default";
    data?: Record<string, unknown>;
} | {
    type: "Action.ShowCard";
    title: string;
    card: AdaptiveCard;
} | {
    type: "Action.ToggleVisibility";
    title: string;
    targetElements: string[];
};
/**
 * Traffic-light level for status rows. Maps to AdaptiveCards colour
 * tokens that Webex actually renders.
 */
export type StatusLevel = "good" | "warning" | "attention" | "accent";
/**
 * Fact-style card — a title, optional subtitle, a FactSet for
 * key/value rows, and optional action buttons. Ideal for PM reports
 * ("Milestone → Status"), inventory summaries, and device reports.
 */
export declare function factCard(opts: {
    title: string;
    subtitle?: string;
    facts: {
        title: string;
        value: string;
    }[];
    actions?: CardAction[];
}): AdaptiveCard;
/**
 * Status card — a list of traffic-light rows, each with an optional
 * trailing value and a colour coded by level. Useful for periodic
 * health-tick / multi-system status posts.
 */
export declare function statusCard(opts: {
    title: string;
    subtitle?: string;
    statuses: {
        label: string;
        value?: string;
        level: StatusLevel;
        detail?: string;
    }[];
    actions?: CardAction[];
}): AdaptiveCard;
/**
 * Approval card — title + body + two Action.Submit buttons (Approve,
 * Deny) plus an optional free-text "notes" input. The `data` object
 * is echoed back on the attachment-actions webhook, so callers embed
 * whatever identifiers they need (session key, approval id, etc.)
 * to route the response.
 *
 * Style hint: the approve button is green, deny is red. Webex honours
 * these on modern clients; older clients fall back to default styling.
 */
export declare function approvalCard(opts: {
    title: string;
    body: string;
    approveLabel?: string;
    denyLabel?: string;
    includeNotes?: boolean;
    data: Record<string, unknown>;
}): AdaptiveCard;
/**
 * Render a slash-command reply (/status, /help, …) as a card: bold
 * command title, the reply body line-by-line (Adaptive Cards collapse
 * plain newlines, so each line becomes its own TextBlock), and optional
 * tap-to-run quick-command buttons whose Action.Submit carries the
 * command in `__openclawCommand` — the channel plugin executes it as if
 * the user had typed it.
 */
export declare function commandReplyCard(opts: {
    command: string;
    body: string;
    quickCommands?: Array<{
        title: string;
        command: string;
    }>;
}): AdaptiveCard;
/**
 * Validate that a card uses only elements Webex's validator will
 * accept. Throws with a precise error message if a banned element or
 * property is present — catches problems locally before the Webex
 * POST /messages round-trip surfaces a generic HTTP 400.
 *
 * Not exhaustive; focuses on the elements and properties known to be
 * rejected by Webex's card validator today.
 */
export declare function validateForWebex(c: AdaptiveCard): void;
