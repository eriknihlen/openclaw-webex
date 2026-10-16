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
import type { GoalCommand } from "./goal-command";
export type GoalStatus = "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete";
export interface SessionGoal {
    id: string;
    objective: string;
    status: GoalStatus;
    tokensUsed?: number;
    tokenBudget?: number;
    lastStatusNote?: string;
    updatedAt?: number;
}
export interface GoalSessionState {
    /** Canonical session key as stored by the Gateway. */
    sessionKey: string;
    sessionId: string;
    goal?: SessionGoal;
    hasActiveRun: boolean;
}
export type GoalUpdateAction = "edit" | "pause" | "complete" | "block";
export interface GoalGateway {
    describe(sessionKey: string, agentId: string): Promise<GoalSessionState | undefined>;
    update(params: {
        state: GoalSessionState;
        agentId: string;
        action: GoalUpdateAction;
        objective?: string;
        note?: string;
    }): Promise<SessionGoal | undefined>;
    clear(params: {
        state: GoalSessionState;
        agentId: string;
    }): Promise<void>;
}
export interface QuickCommand {
    title: string;
    command: string;
}
export interface GoalControlReply {
    text: string;
    quickCommands: QuickCommand[];
}
/** True when the plugin answers this /goal command itself. */
export declare function isGoalControlCommand(parsed: GoalCommand | null): parsed is GoalCommand;
/** Plain-text goal summary, one fact per line (rendered as card lines). */
export declare function formatGoal(goal: SessionGoal | undefined, busy?: boolean): string;
/** Buttons that make sense for the goal's current status. */
export declare function goalQuickCommands(goal: SessionGoal | undefined): QuickCommand[];
/** Execute one plugin-side /goal command and build the reply. */
export declare function runGoalControl(parsed: GoalCommand, ctx: {
    sessionKey: string;
    agentId: string;
    gateway: GoalGateway;
}): Promise<GoalControlReply>;
export declare class GoalGatewayError extends Error {
}
/** Extract the JSON object the CLI prints with --json. */
export declare function parseCliJson(stdout: string): any;
export declare function createCliGoalGateway(opts?: {
    nodePath?: string;
    cliEntry?: string;
    timeoutMs?: number;
}): GoalGateway;
