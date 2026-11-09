/**
 * ProjectRefs.ts — the projects Kaya builds for Jm, by name (project standard:
 * skills/Development/ProjectStandard/SKILL.md).
 *
 * Shared by two skills, so it lives in lib/ (ADR-006):
 *   - ProjectStandard/Tools/ProjectStatus.ts (status and gap check)
 *   - LifeOS/Capture/Router.ts (PROJECT_FEEDBACK files Jm's words into <project>/FEEDBACK.md)
 *
 * A project is a real git repo in ~/projects, a folder there with a stamped AGENTS.md, or a skill
 * folder (`skills/<category>/<skill>`) with an AGENTS.md. listProjectRefs reads names only and runs
 * no git, so it is fast enough to call on every capture.
 *
 * @module ProjectRefs
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { kayaHomePath } from "./KayaHome.ts";

/** The stamp on the first line of a project's AGENTS.md and FEEDBACK.md. */
export const PROJECT_STANDARD_STAMP_RE = /project-standard:\s*v(\d+)/;

/** Remove HTML comments, so template examples inside them are not counted. */
export function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

export function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** Non-hidden subfolders of `dir`; none if `dir` does not exist. */
export function subfolders(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => !n.startsWith("."))
    .map((n) => join(dir, n))
    .filter((p) => statSync(p).isDirectory());
}

/** Skill folders (`<skillsDir>/<category>/<skill>`) that hold an AGENTS.md: Kaya-internal projects such as LifeOS. */
export function skillProjectDirs(skillsDir: string): string[] {
  return subfolders(skillsDir)
    .flatMap(subfolders)
    .filter((d) => existsSync(join(d, "AGENTS.md")));
}

/** A project as a capture router needs it: names only. */
export interface ProjectRef {
  key: string;
  dir: string;
  title: string | null;
  aliases: string[];
  summary: string | null;
}

/** First `# ` heading, the "Also called:" names, and the first prose line after the heading. */
function readNames(raw: string): { title: string | null; aliases: string[]; summary: string | null } {
  const visible = stripComments(raw);
  const title = visible.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
  const also = visible.match(/^Also called:\s*(.+)$/m)?.[1] ?? "";
  const aliases = also
    .split(/[,·;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("<"));
  const lines = visible.split("\n");
  const headingIdx = lines.findIndex((l) => /^#\s+/.test(l));
  const prose = lines.slice(headingIdx + 1).find((l) => /^[A-Za-z]/.test(l) && !/^[A-Z][a-z ]+:\s/.test(l));
  return { title, aliases, summary: prose ? prose.trim().slice(0, 140) : null };
}

/**
 * Every project (same rule as ProjectStatus.collectProjects), with names only. Names come from
 * AGENTS.md, else from README.md.
 */
export function listProjectRefs(
  projectsDir: string = join(homedir(), "projects"),
  skillsDir: string = kayaHomePath("skills"),
): ProjectRef[] {
  const dirs = new Set<string>([...subfolders(projectsDir), ...skillProjectDirs(skillsDir)].map((d) => resolve(d)));
  const refs: ProjectRef[] = [];
  for (const dir of dirs) {
    const agentsRaw = readIfExists(join(dir, "AGENTS.md"));
    const stamped = agentsRaw !== null && PROJECT_STANDARD_STAMP_RE.test(agentsRaw);
    const isGitRepo = existsSync(join(dir, ".git")) && statSync(join(dir, ".git")).isDirectory();
    const isSkillProject = agentsRaw !== null && !dir.startsWith(resolve(projectsDir));
    if (!isGitRepo && !stamped && !isSkillProject) continue;
    const source = agentsRaw ?? readIfExists(join(dir, "README.md"));
    const names = source === null ? { title: null, aliases: [], summary: null } : readNames(source);
    refs.push({ key: basename(dir), dir, ...names });
  }
  return refs.sort((a, b) => a.key.localeCompare(b.key));
}

/** Match a name Jm used (key, title or alias; case-insensitive) to one project, or null. */
export function resolveProjectRef(name: string | undefined, refs: ProjectRef[]): ProjectRef | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  return (
    refs.find((r) => r.key.toLowerCase() === n) ??
    refs.find((r) => r.title?.toLowerCase() === n || r.aliases.some((a) => a.toLowerCase() === n)) ??
    null
  );
}
