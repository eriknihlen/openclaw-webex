"use strict";
/**
 * Plugin-side /goal control: answers the goal commands that only read or
 * change the stored goal (status, edit, pause, block, complete, clear)
 * immediately, even while the agent is busy.
 *
 * Core's /goal text command is not active-run safe, so during a running
 * turn it waits for the turn to finish. These actions don't need the
 * model, so the plugin performs them itself through the Gateway's own
 * session goal methods (the ones the Control UI goal panel uses):
 * `sessions.describe` to read, `sessions.goal.update` / `sessions.goal.clear`
 * to change. `api.runtime.gateway.request` is reserved for bundled and
 * trusted official plugins, so the calls go through the OpenClaw CLI
 * (`openclaw gateway call`) running on the gateway's own Node binary.
 *
 * Starting and resuming a goal still go through core, because they run
 * the agent.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoalGatewayError = void 0;
exports.isGoalControlCommand = isGoalControlCommand;
exports.formatGoal = formatGoal;
exports.goalQuickCommands = goalQuickCommands;
exports.runGoalControl = runGoalControl;
exports.parseCliJson = parseCliJson;
exports.createCliGoalGateway = createCliGoalGateway;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
/** Actions answered by the plugin. Start and resume stay with core. */
const CONTROL_ACTIONS = new Set([
    "status",
    "edit",
    "pause",
    "complete",
    "done",
    "block",
    "blocked",
    "clear",
    // Start aliases without an objective only print usage; answered here.
    "start",
    "set",
    "create",
]);
/** True when the plugin answers this /goal command itself. */
function isGoalControlCommand(parsed) {
    if (!parsed || !CONTROL_ACTIONS.has(parsed.action))
        return false;
    if (parsed.action === "start" || parsed.action === "set" || parsed.action === "create") {
        return parsed.text.length === 0;
    }
    return true;
}
const STATUS_LABELS = {
    active: "🟢 active",
    paused: "⏸ paused",
    blocked: "🚧 blocked",
    usage_limited: "⚠️ usage limited",
    budget_limited: "⚠️ token budget reached",
    complete: "✅ complete",
};
function formatTokens(n) {
    if (typeof n !== "number" || !Number.isFinite(n))
        return undefined;
    return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}
/** Plain-text goal summary, one fact per line (rendered as card lines). */
function formatGoal(goal, busy = false) {
    if (!goal) {
        return [
            "No goal is set for this conversation.",
            "Start one with: /goal <objective>",
        ].join("\n");
    }
    const lines = [`Status: ${STATUS_LABELS[goal.status] ?? goal.status}`, `Objective: ${goal.objective}`];
    const used = formatTokens(goal.tokensUsed);
    const budget = formatTokens(goal.tokenBudget);
    if (used)
        lines.push(`Tokens used: ${used}${budget ? ` of ${budget}` : ""}`);
    if (goal.lastStatusNote)
        lines.push(`Note: ${goal.lastStatusNote}`);
    if (busy)
        lines.push("Working on a task right now.");
    return lines.join("\n");
}
/** Buttons that make sense for the goal's current status. */
function goalQuickCommands(goal) {
    const status = { title: "🎯 Goal status", command: "/goal" };
    if (!goal)
        return [status, { title: "📊 Status", command: "/status" }];
    switch (goal.status) {
        case "active":
            return [
                status,
                { title: "⏸ Pause", command: "/goal pause" },
                { title: "✅ Complete", command: "/goal complete" },
                { title: "🚧 Block", command: "/goal block" },
            ];
        case "complete":
            return [status, { title: "🗑 Clear", command: "/goal clear" }];
        default:
            // paused, blocked, usage/budget limited
            return [
                status,
                { title: "▶️ Resume", command: "/goal resume" },
                { title: "✅ Complete", command: "/goal complete" },
                { title: "🗑 Clear", command: "/goal clear" },
            ];
    }
}
const VERB = {
    edit: "updated",
    pause: "paused",
    complete: "complete",
    block: "blocked",
};
/** Execute one plugin-side /goal command and build the reply. */
async function runGoalControl(parsed, ctx) {
    const action = parsed.action === "done" ? "complete" : parsed.action === "blocked" ? "block" : parsed.action;
    if (action === "start" || action === "set" || action === "create") {
        return { text: "Usage: /goal start <objective>", quickCommands: goalQuickCommands(undefined) };
    }
    if (action === "edit" && !parsed.text) {
        return { text: "Usage: /goal edit <new objective>", quickCommands: [{ title: "🎯 Goal status", command: "/goal" }] };
    }
    const state = await ctx.gateway.describe(ctx.sessionKey, ctx.agentId);
    if (!state) {
        return { text: formatGoal(undefined), quickCommands: goalQuickCommands(undefined) };
    }
    if (action === "status") {
        return { text: formatGoal(state.goal, state.hasActiveRun), quickCommands: goalQuickCommands(state.goal) };
    }
    if (!state.goal) {
        return {
            text: action === "clear" ? "No goal to clear." : formatGoal(undefined),
            quickCommands: goalQuickCommands(undefined),
        };
    }
    let updated;
    try {
        if (action === "clear") {
            await ctx.gateway.clear({ state, agentId: ctx.agentId });
            return { text: "Goal cleared.", quickCommands: goalQuickCommands(undefined) };
        }
        const update = action;
        updated = await ctx.gateway.update({
            state,
            agentId: ctx.agentId,
            action: update,
            ...(update === "edit" ? { objective: parsed.text } : parsed.text ? { note: parsed.text } : {}),
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { text: `Goal error: ${message}`, quickCommands: goalQuickCommands(state.goal) };
    }
    // The update result carries the new goal; re-read only if it doesn't.
    const goal = updated ?? (await ctx.gateway.describe(ctx.sessionKey, ctx.agentId).catch(() => undefined))?.goal ?? state.goal;
    const verb = VERB[action];
    return {
        text: [`Goal ${verb}.`, formatGoal(goal, state.hasActiveRun)].join("\n"),
        quickCommands: goalQuickCommands(goal),
    };
}
// ---------------------------------------------------------------------------
// Gateway client over the OpenClaw CLI
// ---------------------------------------------------------------------------
class GoalGatewayError extends Error {
}
exports.GoalGatewayError = GoalGatewayError;
/** Extract the JSON object the CLI prints with --json. */
function parseCliJson(stdout) {
    const start = stdout.indexOf("{");
    const end = stdout.lastIndexOf("}");
    if (start === -1 || end < start)
        throw new GoalGatewayError("no JSON in gateway response");
    const parsed = JSON.parse(stdout.slice(start, end + 1));
    if (parsed && parsed.ok === false) {
        const message = parsed.error?.message ?? "gateway call failed";
        throw new GoalGatewayError(String(message));
    }
    return parsed;
}
function lastLine(text) {
    const lines = text.trim().split("\n").filter(Boolean);
    return (lines[lines.length - 1] ?? "").slice(0, 300);
}
function createCliGoalGateway(opts = {}) {
    const nodePath = opts.nodePath ?? process.execPath;
    const cliEntry = opts.cliEntry ?? process.argv[1];
    const timeoutMs = opts.timeoutMs ?? 20_000;
    const call = (method, params) => new Promise((resolve, reject) => {
        if (!cliEntry) {
            reject(new GoalGatewayError("OpenClaw CLI entry not found"));
            return;
        }
        (0, node_child_process_1.execFile)(nodePath, [cliEntry, "gateway", "call", method, "--params", JSON.stringify(params), "--json"], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
            try {
                resolve(parseCliJson(String(stdout ?? "")));
            }
            catch (parseErr) {
                const detail = lastLine(String(stderr ?? "")) || lastLine(String(stdout ?? ""));
                const base = parseErr instanceof Error ? parseErr.message : String(parseErr);
                reject(new GoalGatewayError(err && !detail ? err.message : detail || base));
            }
        });
    });
    const identity = (state, agentId) => ({
        sessionKey: state.sessionKey,
        agentId,
        sessionId: state.sessionId,
        goalId: state.goal?.id ?? "",
        operationId: `webex-goal-${(0, node_crypto_1.randomUUID)()}`,
        issuedAtMs: Date.now(),
    });
    return {
        async describe(sessionKey, agentId) {
            const res = await call("sessions.describe", { key: sessionKey, agentId });
            const session = res?.session;
            if (!session?.key || !session?.sessionId)
                return undefined;
            const goal = session.goal && typeof session.goal === "object" ? session.goal : undefined;
            return {
                sessionKey: String(session.key),
                sessionId: String(session.sessionId),
                goal,
                hasActiveRun: session.hasActiveRun === true,
            };
        },
        async update({ state, agentId, action, objective, note }) {
            const res = await call("sessions.goal.update", {
                ...identity(state, agentId),
                action,
                ...(action === "edit" ? { objective } : note ? { note: note.slice(0, 2000) } : {}),
            });
            return res?.goal && typeof res.goal === "object" ? res.goal : undefined;
        },
        async clear({ state, agentId }) {
            await call("sessions.goal.clear", identity(state, agentId));
        },
    };
}
//# sourceMappingURL=goal-control.js.map