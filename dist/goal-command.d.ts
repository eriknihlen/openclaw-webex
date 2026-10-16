/**
 * /goal support for the Webex channel.
 *
 * Core owns /goal (commands-goal.ts): bare /goal and the control actions
 * (status, edit, pause, complete, block, clear) answer synchronously like
 * any other slash command, but starting a goal — `/goal <objective>`,
 * `/goal start|set|create <objective>` — and `/goal resume` rewrite the
 * turn into a continuation prompt and run the agent. Those turns can take
 * minutes, so the plugin must treat them as agent turns (placeholder,
 * progress, normal chunked reply) rather than as command turns (no
 * placeholder, reply squeezed into a command card).
 *
 * The action parsing mirrors core's parseGoalCommand: the first word is an
 * action only when it is one of GOAL_ACTIONS; any other text is a new
 * objective.
 */
export type GoalCommand = {
    action: string;
    text: string;
};
/** Parse a /goal message, or return null when the text is not /goal. */
export declare function parseGoalCommand(raw: string | undefined): GoalCommand | null;
/**
 * True when this /goal message makes core run the agent. A start action
 * without an objective only returns a usage line, so it stays a command.
 */
export declare function isGoalAgentTurn(raw: string | undefined): boolean;
/** Quick-command buttons for /goal reply cards. */
export declare const GOAL_QUICK_COMMANDS: {
    title: string;
    command: string;
}[];
