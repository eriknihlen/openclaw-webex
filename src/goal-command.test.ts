import { describe, expect, it } from "vitest";
import { isGoalAgentTurn, parseGoalCommand } from "./goal-command";

describe("parseGoalCommand", () => {
  it("ignores non-goal text", () => {
    expect(parseGoalCommand("/status")).toBeNull();
    expect(parseGoalCommand("/goals")).toBeNull();
    expect(parseGoalCommand("set a goal")).toBeNull();
    expect(parseGoalCommand(undefined)).toBeNull();
  });

  it("treats bare /goal as status", () => {
    expect(parseGoalCommand("/goal")).toEqual({ action: "status", text: "" });
    expect(parseGoalCommand("  /goal  ")).toEqual({ action: "status", text: "" });
  });

  it("parses known actions case-insensitively", () => {
    expect(parseGoalCommand("/goal pause waiting for CI")).toEqual({
      action: "pause",
      text: "waiting for CI",
    });
    expect(parseGoalCommand("/goal Complete")).toEqual({ action: "complete", text: "" });
  });

  it("treats unknown first words as a new objective", () => {
    expect(parseGoalCommand("/goal migrate site 400 to UX2")).toEqual({
      action: "start",
      text: "migrate site 400 to UX2",
    });
  });
});

describe("isGoalAgentTurn", () => {
  it("is true for goal creation with an objective and for resume", () => {
    expect(isGoalAgentTurn("/goal migrate site 400 to UX2")).toBe(true);
    expect(isGoalAgentTurn("/goal start migrate site 400")).toBe(true);
    expect(isGoalAgentTurn("/goal set x")).toBe(true);
    expect(isGoalAgentTurn("/goal create x")).toBe(true);
    expect(isGoalAgentTurn("/goal resume")).toBe(true);
    expect(isGoalAgentTurn("/goal resume CI is green now")).toBe(true);
  });

  it("is false for control actions, usage-only starts and other text", () => {
    for (const text of [
      "/goal",
      "/goal status",
      "/goal start",
      "/goal edit new wording",
      "/goal pause",
      "/goal complete done",
      "/goal done",
      "/goal block waiting",
      "/goal clear",
      "/status",
      "hello",
    ]) {
      expect(isGoalAgentTurn(text)).toBe(false);
    }
  });
});
