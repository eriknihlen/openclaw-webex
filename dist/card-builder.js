"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.factCard = factCard;
exports.statusCard = statusCard;
exports.approvalCard = approvalCard;
exports.commandReplyCard = commandReplyCard;
exports.validateForWebex = validateForWebex;
const SCHEMA_VERSION = "1.3";
const LEVEL_COLOR = {
    good: "good",
    warning: "warning",
    attention: "attention",
    accent: "accent",
};
/**
 * Root card wrapper — consistent schema + type across all templates.
 */
function card(body, actions) {
    const out = {
        type: "AdaptiveCard",
        version: SCHEMA_VERSION,
        body,
    };
    if (actions && actions.length > 0) {
        out.actions = actions;
    }
    return out;
}
/**
 * Fact-style card — a title, optional subtitle, a FactSet for
 * key/value rows, and optional action buttons. Ideal for PM reports
 * ("Milestone → Status"), inventory summaries, and device reports.
 */
function factCard(opts) {
    const body = [
        {
            type: "TextBlock",
            text: opts.title,
            weight: "Bolder",
            size: "Medium",
            wrap: true,
        },
    ];
    if (opts.subtitle) {
        body.push({
            type: "TextBlock",
            text: opts.subtitle,
            isSubtle: true,
            spacing: "Small",
            wrap: true,
        });
    }
    body.push({
        type: "FactSet",
        facts: opts.facts.map((f) => ({ title: f.title, value: f.value })),
    });
    return card(body, opts.actions);
}
/**
 * Status card — a list of traffic-light rows, each with an optional
 * trailing value and a colour coded by level. Useful for periodic
 * health-tick / multi-system status posts.
 */
function statusCard(opts) {
    const body = [
        {
            type: "TextBlock",
            text: opts.title,
            weight: "Bolder",
            size: "Medium",
            wrap: true,
        },
    ];
    if (opts.subtitle) {
        body.push({
            type: "TextBlock",
            text: opts.subtitle,
            isSubtle: true,
            spacing: "Small",
            wrap: true,
        });
    }
    for (const row of opts.statuses) {
        const columns = [
            {
                type: "Column",
                width: "auto",
                items: [
                    {
                        type: "TextBlock",
                        text: "●",
                        color: LEVEL_COLOR[row.level],
                        weight: "Bolder",
                    },
                ],
            },
            {
                type: "Column",
                width: "stretch",
                items: [
                    {
                        type: "TextBlock",
                        text: row.label,
                        wrap: true,
                    },
                    ...(row.detail
                        ? [
                            {
                                type: "TextBlock",
                                text: row.detail,
                                isSubtle: true,
                                spacing: "Small",
                                wrap: true,
                            },
                        ]
                        : []),
                ],
            },
        ];
        if (row.value !== undefined) {
            columns.push({
                type: "Column",
                width: "auto",
                items: [
                    {
                        type: "TextBlock",
                        text: row.value,
                        weight: "Bolder",
                        horizontalAlignment: "Right",
                    },
                ],
            });
        }
        body.push({
            type: "ColumnSet",
            columns,
            spacing: "Small",
        });
    }
    return card(body, opts.actions);
}
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
function approvalCard(opts) {
    const body = [
        {
            type: "TextBlock",
            text: opts.title,
            weight: "Bolder",
            size: "Medium",
            wrap: true,
        },
        {
            type: "TextBlock",
            text: opts.body,
            wrap: true,
            spacing: "Small",
        },
    ];
    if (opts.includeNotes) {
        body.push({
            type: "Input.Text",
            id: "notes",
            label: "Notes (optional)",
            placeholder: "Anything the agent should know before acting on your decision",
            isMultiline: true,
        });
    }
    const approveLabel = opts.approveLabel ?? "Approve";
    const denyLabel = opts.denyLabel ?? "Deny";
    const actions = [
        {
            type: "Action.Submit",
            title: approveLabel,
            style: "positive",
            data: { ...opts.data, decision: "approve" },
        },
        {
            type: "Action.Submit",
            title: denyLabel,
            style: "destructive",
            data: { ...opts.data, decision: "deny" },
        },
    ];
    return card(body, actions);
}
/**
 * Render a slash-command reply (/status, /help, …) as a card: bold
 * command title, the reply body line-by-line (Adaptive Cards collapse
 * plain newlines, so each line becomes its own TextBlock), and optional
 * tap-to-run quick-command buttons whose Action.Submit carries the
 * command in `__openclawCommand` — the channel plugin executes it as if
 * the user had typed it.
 */
function commandReplyCard(opts) {
    const lines = opts.body.split("\n").slice(0, 60);
    const body = [
        {
            type: "TextBlock",
            text: opts.command,
            weight: "bolder",
            size: "medium",
            wrap: true,
        },
        ...lines.map((line, i) => ({
            type: "TextBlock",
            text: line.length > 0 ? line : " ",
            wrap: true,
            spacing: i === 0 ? "small" : "none",
        })),
    ];
    const actions = (opts.quickCommands ?? []).slice(0, 6).map((q) => ({
        type: "Action.Submit",
        title: q.title,
        data: { __openclawCommand: q.command },
    }));
    return card(body, actions.length > 0 ? actions : undefined);
}
/**
 * Validate that a card uses only elements Webex's validator will
 * accept. Throws with a precise error message if a banned element or
 * property is present — catches problems locally before the Webex
 * POST /messages round-trip surfaces a generic HTTP 400.
 *
 * Not exhaustive; focuses on the elements and properties known to be
 * rejected by Webex's card validator today.
 */
function validateForWebex(c) {
    if (c.type !== "AdaptiveCard") {
        throw new Error(`Invalid card type: ${c.type}`);
    }
    if (c.version !== "1.0" && c.version !== "1.1" && c.version !== "1.2" && c.version !== "1.3") {
        throw new Error(`Unsupported AdaptiveCards version for Webex: ${c.version}`);
    }
    const seen = { actions: 0 };
    const walk = (nodes) => {
        if (!nodes)
            return;
        for (const node of nodes) {
            if (!node || typeof node !== "object")
                continue;
            const n = node;
            const t = n.type;
            if (t === "Media") {
                throw new Error("Webex does not support Media elements");
            }
            if (t === "Action.Execute") {
                throw new Error("Webex does not support Action.Execute");
            }
            if (t && t.startsWith("Action."))
                seen.actions++;
            if ("speak" in n) {
                throw new Error("Webex does not support the `speak` property");
            }
            if ("verticalContentAlignment" in n && t === "AdaptiveCard") {
                throw new Error("Webex does not support verticalContentAlignment at card level");
            }
            if (t === "ColumnSet" && "height" in n) {
                throw new Error("Webex does not support `height` on ColumnSet");
            }
            // Recurse — body, items, columns, actions, card (inside Action.ShowCard).
            for (const key of ["body", "items", "columns", "actions", "card"]) {
                const v = n[key];
                if (Array.isArray(v))
                    walk(v);
                else if (v && typeof v === "object")
                    walk([v]);
            }
        }
    };
    walk(c.body);
    walk(c.actions);
    if (seen.actions > 20) {
        throw new Error(`Webex allows at most 20 top-level actions per card (got ${seen.actions}); use ActionSet to nest more`);
    }
}
//# sourceMappingURL=card-builder.js.map