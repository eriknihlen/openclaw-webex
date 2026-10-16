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

const GOAL_ACTIONS = new Set([
  "block",
  "blocked",
  "clear",
  "complete",
  "create",
  "done",
  "edit",
  "pause",
  "resume",
  "set",
  "start",
  "status",
]);

/** Actions core turns into an agent run (continuation prompt). */
const AGENT_RUN_ACTIONS = new Set(["start", "set", "create", "resume"]);

export type GoalCommand = { action: string; text: string };

/** Parse a /goal message, or return null when the text is not /goal. */
export function parseGoalCommand(raw: string | undefined): GoalCommand | null {
  const trimmed = (raw ?? "").trim();
  const match = /^\/goal(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) return null;
  const argText = (match[1] ?? "").trim();
  if (!argText) return { action: "status", text: "" };
  const actionEnd = argText.search(/\s/);
  const actionRaw = actionEnd === -1 ? argText : argText.slice(0, actionEnd);
  const action = actionRaw.toLowerCase();
  if (!GOAL_ACTIONS.has(action)) return { action: "start", text: argText };
  return { action, text: actionEnd === -1 ? "" : argText.slice(actionEnd).trim() };
}

/**
 * True when this /goal message makes core run the agent. A start action
 * without an objective only returns a usage line, so it stays a command.
 */
export function isGoalAgentTurn(raw: string | undefined): boolean {
  const parsed = parseGoalCommand(raw);
  if (!parsed || !AGENT_RUN_ACTIONS.has(parsed.action)) return false;
  return parsed.action === "resume" || parsed.text.length > 0;
}

/** Quick-command buttons for /goal reply cards. */
export const GOAL_QUICK_COMMANDS = [
  { title: "🎯 Goal status", command: "/goal" },
  { title: "⏸ Pause", command: "/goal pause" },
  { title: "▶️ Resume", command: "/goal resume" },
  { title: "✅ Complete", command: "/goal complete" },
  { title: "🗑 Clear", command: "/goal clear" },
  { title: "📊 Status", command: "/status" },
];
