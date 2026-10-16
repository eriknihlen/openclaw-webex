import { describe, expect, it } from "vitest";
import { parseGoalCommand } from "./goal-command";
import {
  formatGoal,
  goalQuickCommands,
  isGoalControlCommand,
  parseCliJson,
  runGoalControl,
  type GoalGateway,
  type GoalSessionState,
  type SessionGoal,
} from "./goal-control";

function fakeGateway(initial?: SessionGoal, opts: { busy?: boolean; failUpdate?: string } = {}) {
  let goal = initial ? { ...initial } : undefined;
  const calls: Array<{ op: string; action?: string; objective?: string; note?: string; goalId?: string }> = [];
  const state = (): GoalSessionState => ({
    sessionKey: "agent:main:webex:room",
    sessionId: "sid-1",
    goal: goal ? { ...goal } : undefined,
    hasActiveRun: opts.busy === true,
  });
  const gateway: GoalGateway = {
    async describe() {
      return state();
    },
    async update({ state: s, action, objective, note }) {
      calls.push({ op: "update", action, objective, note, goalId: s.goal?.id });
      if (opts.failUpdate) throw new Error(opts.failUpdate);
      if (!goal) throw new Error("no goal");
      if (action === "edit") goal.objective = objective ?? goal.objective;
      else goal.status = ({ pause: "paused", complete: "complete", block: "blocked" } as const)[action];
      if (note) goal.lastStatusNote = note;
      return { ...goal };
    },
    async clear({ state: s }) {
      calls.push({ op: "clear", goalId: s.goal?.id });
      goal = undefined;
    },
  };
  return { gateway, calls, current: () => goal };
}

const ACTIVE: SessionGoal = { id: "g1", objective: "Find the fewest groups", status: "active", tokensUsed: 12_345 };

async function run(text: string, gw: GoalGateway) {
  const parsed = parseGoalCommand(text);
  expect(isGoalControlCommand(parsed)).toBe(true);
  return runGoalControl(parsed!, { sessionKey: "agent:main:webex:room", agentId: "main", gateway: gw });
}

describe("isGoalControlCommand", () => {
  it("covers status and state changes, not start/resume", () => {
    for (const t of ["/goal", "/goal status", "/goal pause", "/goal edit x", "/goal complete", "/goal done", "/goal block", "/goal blocked", "/goal clear", "/goal start"]) {
      expect(isGoalControlCommand(parseGoalCommand(t))).toBe(true);
    }
    for (const t of ["/goal do the thing", "/goal start do it", "/goal resume", "/status", "hello"]) {
      expect(isGoalControlCommand(parseGoalCommand(t))).toBe(false);
    }
  });
});

describe("runGoalControl", () => {
  it("shows status without changing anything", async () => {
    const f = fakeGateway(ACTIVE, { busy: true });
    const r = await run("/goal", f.gateway);
    expect(r.text).toContain("Status: 🟢 active");
    expect(r.text).toContain("Objective: Find the fewest groups");
    expect(r.text).toContain("Tokens used: 12k");
    expect(r.text).toContain("Working on a task right now.");
    expect(f.calls).toHaveLength(0);
  });

  it("pauses with a note, and offers resume afterwards", async () => {
    const f = fakeGateway(ACTIVE);
    const r = await run("/goal pause waiting for CI", f.gateway);
    expect(f.calls).toEqual([{ op: "update", action: "pause", objective: undefined, note: "waiting for CI", goalId: "g1" }]);
    expect(r.text).toMatch(/^Goal paused\./);
    expect(r.text).toContain("Note: waiting for CI");
    expect(r.quickCommands.map((q) => q.command)).toContain("/goal resume");
  });

  it("edits the objective", async () => {
    const f = fakeGateway(ACTIVE);
    const r = await run("/goal edit New wording", f.gateway);
    expect(f.calls[0]).toMatchObject({ action: "edit", objective: "New wording" });
    expect(r.text).toContain("Objective: New wording");
  });

  it("maps done → complete and blocked → block", async () => {
    const a = fakeGateway(ACTIVE);
    await run("/goal done verified", a.gateway);
    expect(a.calls[0]).toMatchObject({ action: "complete", note: "verified" });
    expect(a.current()?.status).toBe("complete");
    const b = fakeGateway(ACTIVE);
    await run("/goal blocked", b.gateway);
    expect(b.calls[0]).toMatchObject({ action: "block" });
  });

  it("clears the goal", async () => {
    const f = fakeGateway({ ...ACTIVE, status: "complete" });
    const r = await run("/goal clear", f.gateway);
    expect(r.text).toBe("Goal cleared.");
    expect(f.current()).toBeUndefined();
  });

  it("handles no goal without calling the gateway mutations", async () => {
    const f = fakeGateway(undefined);
    expect((await run("/goal", f.gateway)).text).toContain("No goal is set");
    expect((await run("/goal clear", f.gateway)).text).toBe("No goal to clear.");
    expect((await run("/goal pause", f.gateway)).text).toContain("No goal is set");
    expect(f.calls).toHaveLength(0);
  });

  it("prints usage for start or edit without text", async () => {
    const f = fakeGateway(ACTIVE);
    expect((await run("/goal start", f.gateway)).text).toBe("Usage: /goal start <objective>");
    expect((await run("/goal edit", f.gateway)).text).toBe("Usage: /goal edit <new objective>");
    expect(f.calls).toHaveLength(0);
  });

  it("reports gateway errors as Goal error", async () => {
    const f = fakeGateway({ ...ACTIVE, status: "complete" }, { failUpdate: "goal is complete" });
    const r = await run("/goal pause", f.gateway);
    expect(r.text).toBe("Goal error: goal is complete");
  });
});

describe("goalQuickCommands", () => {
  it("offers buttons that fit the status", () => {
    const cmds = (g?: SessionGoal) => goalQuickCommands(g).map((q) => q.command);
    expect(cmds(ACTIVE)).toEqual(["/goal", "/goal pause", "/goal complete", "/goal block"]);
    expect(cmds({ ...ACTIVE, status: "paused" })).toEqual(["/goal", "/goal resume", "/goal complete", "/goal clear"]);
    expect(cmds({ ...ACTIVE, status: "complete" })).toEqual(["/goal", "/goal clear"]);
    expect(cmds(undefined)).toEqual(["/goal", "/status"]);
  });
});

describe("formatGoal / parseCliJson", () => {
  it("formats the empty state", () => {
    expect(formatGoal(undefined)).toContain("/goal <objective>");
  });

  it("extracts JSON and surfaces CLI errors", () => {
    expect(parseCliJson('noise\n{"session":{"key":"k"}}\n')).toEqual({ session: { key: "k" } });
    expect(() => parseCliJson('{"ok":false,"error":{"message":"denied"}}')).toThrow("denied");
    expect(() => parseCliJson("no json")).toThrow();
  });
});
