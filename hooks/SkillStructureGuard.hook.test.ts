import { describe, expect, test } from "bun:test";
import { resolveSkillTarget } from "./SkillStructureGuard.hook.ts";

const HOME = "/home/u/.claude";

describe("resolveSkillTarget", () => {
  test("live tree SKILL.md maps to its category", () => {
    expect(resolveSkillTarget(`${HOME}/skills/Intelligence/Research/SKILL.md`, HOME)).toEqual({
      root: HOME,
      category: "Intelligence",
    });
  });

  test("a trailing slash on the Kaya home does not matter", () => {
    expect(resolveSkillTarget(`${HOME}/skills/Life/Journal/SKILL.md`, `${HOME}/`)?.category).toBe("Life");
  });

  test("a worktree SKILL.md maps to the worktree root, not the live tree", () => {
    const wt = `${HOME}/.claude/worktrees/agent-1`;
    expect(resolveSkillTarget(`${wt}/skills/Life/Journal/SKILL.md`, HOME)).toEqual({ root: wt, category: "Life" });
  });

  test("Windows separators are accepted", () => {
    const result = resolveSkillTarget("C:\\k\\.claude\\worktrees\\w\\skills\\Life\\Journal\\SKILL.md", "/x");
    expect(result?.category).toBe("Life");
  });

  test.each([
    ["wrong depth", `${HOME}/skills/Life/SKILL.md`],
    ["too deep", `${HOME}/skills/Life/Journal/Tools/SKILL.md`],
    ["not SKILL.md", `${HOME}/skills/Life/Journal/README.md`],
    ["outside the home and any worktree", "/tmp/other/skills/Life/Journal/SKILL.md"],
  ])("returns null for %s", (_name, path) => {
    expect(resolveSkillTarget(path, HOME)).toBeNull();
  });
});
