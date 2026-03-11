#!/usr/bin/env bun
/**
 * ============================================================================
 * TEAMS BRIDGE - Central Abstraction for Claude Code Agent Teams
 * ============================================================================
 *
 * PURPOSE:
 * Provides a unified interface to Claude Code's Agent Teams feature.
 * All Kaya skills use this instead of reimplementing TeammateTool calls.
 * Feature-flagged: gracefully returns null/fallback when unavailable.
 *
 * AGENT TEAMS OVERVIEW:
 * Agent Teams creates independent Claude Code instances (teammates) that
 * each run in their own process with their own git context. Teammates
 * communicate via inbox messaging (peer-to-peer). This solves the
 * git branch contamination bug where concurrent git operations in a
 * shared process cause commits to land on wrong branches.
 *
 * USAGE:
 *   import { TeamsBridge } from './TeamsBridge.ts';
 *
 *   if (TeamsBridge.isAvailable()) {
 *     const team = await TeamsBridge.create({ teamName: 'my-team' });
 *     const members = await team.spawn([
 *       { role: 'worker-1', task: 'Implement feature A', workingDir: '/path/a' },
 *       { role: 'worker-2', task: 'Implement feature B', workingDir: '/path/b' },
 *     ]);
 *     await team.broadcast('Starting work');
 *     // ... monitor and collect results ...
 *     await team.cleanup();
 *   }
 *
 * ============================================================================
 */

import { spawn as spawnProcess, execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { z } from "zod";

// ============================================================================
// Types
// ============================================================================

export type TeamDisplayMode = "in_process" | "background";
export type TeamMemberModel = "haiku" | "sonnet" | "opus";
export type TeamMemberStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/**
 * Configuration for creating a team
 */
export interface TeamConfig {
  /** Human-readable team name */
  teamName: string;
  /** Display mode: in_process (visible) or background (hidden) */
  displayMode?: TeamDisplayMode;
  /** Whether to delegate all work to team members (lead does no work itself) */
  delegateMode?: boolean;
  /** Auto-cleanup on completion */
  autoCleanup?: boolean;
  /** Default model for team members */
  defaultModel?: TeamMemberModel;
  /** Default timeout per member in ms */
  defaultTimeoutMs?: number;
}

/**
 * Specification for a team member to spawn
 */
export interface TeamMemberSpec {
  /** Role name (used as identifier) */
  role: string;
  /** The task/prompt for this member */
  task: string;
  /** Working directory for this member's Claude Code instance */
  workingDir?: string;
  /** Model override for this member */
  model?: TeamMemberModel;
  /** Timeout override in ms */
  timeoutMs?: number;
  /** System prompt prefix */
  systemPrompt?: string;
  /** ElevenLabs voice ID for announcements */
  voiceId?: string;
}

/**
 * Result from a team member's execution
 */
export interface TeamMemberResult {
  /** Role name */
  role: string;
  /** Execution status */
  status: TeamMemberStatus;
  /** Output text (if completed) */
  output?: string;
  /** Error message (if failed) */
  error?: string;
  /** Execution duration in ms */
  durationMs: number;
  /** Model used */
  model: TeamMemberModel;
  /** Exit code from process */
  exitCode?: number;
}

/**
 * A shared task in the team's task queue
 */
export interface SharedTask {
  /** Unique task ID */
  id: string;
  /** Task title */
  title: string;
  /** Task description */
  description: string;
  /** Status */
  status: "pending" | "in_progress" | "completed" | "failed";
  /** Who created it */
  createdBy: string;
  /** Who is working on it */
  assignedTo?: string;
  /** Result or output */
  result?: string;
  /** Timestamps */
  createdAt: string;
  updatedAt: string;
}

/**
 * A message in a team member's inbox
 */
export interface TeamMessage {
  /** Sender role */
  from: string;
  /** Recipient role (or "all" for broadcast) */
  to: string;
  /** Message content */
  content: string;
  /** Timestamp */
  timestamp: string;
}

/**
 * Active team instance with operational methods
 */
export interface Team {
  /** Team identifier */
  teamId: string;
  /** Team name */
  teamName: string;
  /** Team directory for state */
  teamDir: string;

  /**
   * Spawn team members from specs
   */
  spawn(members: TeamMemberSpec[]): Promise<TeamMemberResult[]>;

  /**
   * Send a message to a specific team member
   */
  send(memberId: string, message: string): Promise<void>;

  /**
   * Broadcast a message to all team members
   */
  broadcast(message: string): Promise<void>;

  /**
   * Create a shared task visible to all members
   */
  createSharedTask(title: string, description: string): Promise<SharedTask>;

  /**
   * Get all shared tasks
   */
  getSharedTasks(): SharedTask[];

  /**
   * Update a shared task's status
   */
  updateSharedTask(taskId: string, update: Partial<Pick<SharedTask, "status" | "assignedTo" | "result">>): Promise<void>;

  /**
   * Request graceful shutdown of all members
   */
  requestShutdown(): Promise<void>;

  /**
   * Clean up team state and processes
   */
  cleanup(): Promise<void>;

  /**
   * Get team member results
   */
  getResults(): TeamMemberResult[];
}

// ============================================================================
// Zod Schemas
// ============================================================================

const SharedTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "failed"]),
  createdBy: z.string(),
  assignedTo: z.string().optional(),
  result: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const TeamMessageSchema = z.object({
  from: z.string(),
  to: z.string(),
  content: z.string(),
  timestamp: z.string(),
});

// ============================================================================
// Constants
// ============================================================================

const HOME = homedir();
const KAYA_DIR = process.env.KAYA_DIR || join(HOME, ".claude");
const TEAMS_DIR = join(KAYA_DIR, "MEMORY", "teams");
const ENV_FLAG = "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS";

// ============================================================================
// TeamsBridge Implementation
// ============================================================================

export const TeamsBridge = {
  /**
   * Check if Agent Teams feature is available.
   * Returns true when the env flag is set to "1" or "true".
   */
  isAvailable(): boolean {
    const flag = process.env[ENV_FLAG];
    return flag === "1" || flag === "true";
  },

  /**
   * Create a new team. Returns null if Agent Teams is unavailable.
   * This allows callers to gracefully fall back to legacy patterns.
   */
  async create(config: TeamConfig): Promise<Team | null> {
    if (!this.isAvailable()) {
      return null;
    }

    const teamId = `team_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const teamDir = join(TEAMS_DIR, teamId);

    // Create team directory structure
    mkdirSync(join(teamDir, "inboxes"), { recursive: true });
    mkdirSync(join(teamDir, "tasks"), { recursive: true });
    mkdirSync(join(teamDir, "results"), { recursive: true });

    // Write team manifest
    const manifest = {
      teamId,
      teamName: config.teamName,
      displayMode: config.displayMode || "in_process",
      delegateMode: config.delegateMode ?? true,
      autoCleanup: config.autoCleanup ?? true,
      defaultModel: config.defaultModel || "sonnet",
      defaultTimeoutMs: config.defaultTimeoutMs || 300000,
      createdAt: new Date().toISOString(),
      members: [] as string[],
    };
    writeFileSync(join(teamDir, "manifest.json"), JSON.stringify(manifest, null, 2));

    // Initialize shared task queue
    writeFileSync(join(teamDir, "tasks", "queue.json"), JSON.stringify([], null, 2));

    const results: TeamMemberResult[] = [];
    const runningProcesses = new Map<string, ReturnType<typeof spawnProcess>>();

    return {
      teamId,
      teamName: config.teamName,
      teamDir,

      async spawn(members: TeamMemberSpec[]): Promise<TeamMemberResult[]> {
        const memberResults: TeamMemberResult[] = [];

        // Create inbox directories for each member
        for (const member of members) {
          mkdirSync(join(teamDir, "inboxes", member.role), { recursive: true });
          writeFileSync(
            join(teamDir, "inboxes", member.role, "messages.json"),
            JSON.stringify([], null, 2)
          );
        }

        // Update manifest with member roles
        manifest.members = members.map((m) => m.role);
        writeFileSync(join(teamDir, "manifest.json"), JSON.stringify(manifest, null, 2));

        // Spawn all members as independent Claude Code processes
        const spawnPromises = members.map(async (member) => {
          const model = member.model || config.defaultModel || "sonnet";
          const timeout = member.timeoutMs || config.defaultTimeoutMs || 300000;
          const workingDir = member.workingDir || KAYA_DIR;
          const startTime = Date.now();

          // Build the prompt with team context
          const teamContext = [
            `You are team member "${member.role}" in team "${config.teamName}" (${teamId}).`,
            `Team directory: ${teamDir}`,
            `Your inbox: ${join(teamDir, "inboxes", member.role, "messages.json")}`,
            `Shared tasks: ${join(teamDir, "tasks", "queue.json")}`,
            "",
            "## Team Communication",
            "- Read your inbox by reading the messages.json file in your inbox directory",
            "- To send messages, write to other members' inbox message files",
            "- Check shared tasks in the tasks/queue.json file",
            "",
            "## Your Task",
            member.task,
          ].join("\n");

          const systemPrompt = member.systemPrompt
            ? `${member.systemPrompt}\n\n${teamContext}`
            : teamContext;

          return new Promise<TeamMemberResult>((resolve) => {
            const env = { ...process.env };
            delete env.ANTHROPIC_API_KEY; // Force subscription auth

            const args = [
              "-p",
              "--model", model,
              "--output-format", "text",
              "--setting-sources", "", // Disable hooks to prevent recursion
              "--system-prompt", systemPrompt,
              member.task,
            ];

            let stdout = "";
            let stderr = "";

            const proc = spawnProcess("claude", args, {
              env,
              cwd: workingDir,
              stdio: ["ignore", "pipe", "pipe"],
            });

            runningProcesses.set(member.role, proc);

            proc.stdout?.on("data", (data: Buffer) => {
              stdout += data.toString();
            });

            proc.stderr?.on("data", (data: Buffer) => {
              stderr += data.toString();
            });

            const timeoutId = setTimeout(() => {
              proc.kill("SIGTERM");
              runningProcesses.delete(member.role);
              const result: TeamMemberResult = {
                role: member.role,
                status: "failed",
                error: `Timeout after ${timeout}ms`,
                durationMs: Date.now() - startTime,
                model,
              };
              // Save result
              writeFileSync(
                join(teamDir, "results", `${member.role}.json`),
                JSON.stringify(result, null, 2)
              );
              resolve(result);
            }, timeout);

            proc.on("close", (code: number | null) => {
              clearTimeout(timeoutId);
              runningProcesses.delete(member.role);
              const durationMs = Date.now() - startTime;

              const result: TeamMemberResult = {
                role: member.role,
                status: code === 0 || stdout.trim() ? "completed" : "failed",
                output: stdout.trim() || undefined,
                error: code !== 0 && !stdout.trim() ? stderr.trim() || `Exit code ${code}` : undefined,
                durationMs,
                model,
                exitCode: code ?? undefined,
              };

              // Save result
              writeFileSync(
                join(teamDir, "results", `${member.role}.json`),
                JSON.stringify(result, null, 2)
              );
              resolve(result);
            });

            proc.on("error", (err: Error) => {
              clearTimeout(timeoutId);
              runningProcesses.delete(member.role);
              const result: TeamMemberResult = {
                role: member.role,
                status: "failed",
                error: err.message,
                durationMs: Date.now() - startTime,
                model,
              };
              writeFileSync(
                join(teamDir, "results", `${member.role}.json`),
                JSON.stringify(result, null, 2)
              );
              resolve(result);
            });
          });
        });

        // Wait for all members to complete
        const spawnResults = await Promise.allSettled(spawnPromises);

        for (const result of spawnResults) {
          if (result.status === "fulfilled") {
            memberResults.push(result.value);
            results.push(result.value);
          } else {
            const failResult: TeamMemberResult = {
              role: "unknown",
              status: "failed",
              error: result.reason?.toString(),
              durationMs: 0,
              model: config.defaultModel || "sonnet",
            };
            memberResults.push(failResult);
            results.push(failResult);
          }
        }

        return memberResults;
      },

      async send(memberId: string, message: string): Promise<void> {
        const inboxPath = join(teamDir, "inboxes", memberId, "messages.json");
        if (!existsSync(inboxPath)) {
          throw new Error(`Member "${memberId}" not found in team`);
        }

        const messages: TeamMessage[] = JSON.parse(readFileSync(inboxPath, "utf-8"));
        messages.push({
          from: "lead",
          to: memberId,
          content: message,
          timestamp: new Date().toISOString(),
        });
        writeFileSync(inboxPath, JSON.stringify(messages, null, 2));
      },

      async broadcast(message: string): Promise<void> {
        // Read manifest from disk to pick up members added externally
        const currentManifest = existsSync(join(teamDir, "manifest.json"))
          ? JSON.parse(readFileSync(join(teamDir, "manifest.json"), "utf-8"))
          : manifest;
        const members = currentManifest.members || manifest.members;
        for (const member of members) {
          const inboxPath = join(teamDir, "inboxes", member, "messages.json");
          if (existsSync(inboxPath)) {
            const messages: TeamMessage[] = JSON.parse(readFileSync(inboxPath, "utf-8"));
            messages.push({
              from: "lead",
              to: "all",
              content: message,
              timestamp: new Date().toISOString(),
            });
            writeFileSync(inboxPath, JSON.stringify(messages, null, 2));
          }
        }
      },

      async createSharedTask(title: string, description: string): Promise<SharedTask> {
        const queuePath = join(teamDir, "tasks", "queue.json");
        const tasks: SharedTask[] = existsSync(queuePath)
          ? JSON.parse(readFileSync(queuePath, "utf-8"))
          : [];

        const task: SharedTask = {
          id: `task_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          title,
          description,
          status: "pending",
          createdBy: "lead",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        tasks.push(task);
        writeFileSync(queuePath, JSON.stringify(tasks, null, 2));
        return task;
      },

      getSharedTasks(): SharedTask[] {
        const queuePath = join(teamDir, "tasks", "queue.json");
        if (!existsSync(queuePath)) return [];
        return JSON.parse(readFileSync(queuePath, "utf-8"));
      },

      async updateSharedTask(
        taskId: string,
        update: Partial<Pick<SharedTask, "status" | "assignedTo" | "result">>
      ): Promise<void> {
        const queuePath = join(teamDir, "tasks", "queue.json");
        const tasks: SharedTask[] = existsSync(queuePath)
          ? JSON.parse(readFileSync(queuePath, "utf-8"))
          : [];

        const task = tasks.find((t) => t.id === taskId);
        if (!task) throw new Error(`Task "${taskId}" not found`);

        if (update.status !== undefined) task.status = update.status;
        if (update.assignedTo !== undefined) task.assignedTo = update.assignedTo;
        if (update.result !== undefined) task.result = update.result;
        task.updatedAt = new Date().toISOString();

        writeFileSync(queuePath, JSON.stringify(tasks, null, 2));
      },

      async requestShutdown(): Promise<void> {
        // Send shutdown message to all members
        for (const member of manifest.members) {
          const inboxPath = join(teamDir, "inboxes", member, "messages.json");
          if (existsSync(inboxPath)) {
            const messages: TeamMessage[] = JSON.parse(readFileSync(inboxPath, "utf-8"));
            messages.push({
              from: "lead",
              to: member,
              content: "SHUTDOWN_REQUESTED",
              timestamp: new Date().toISOString(),
            });
            writeFileSync(inboxPath, JSON.stringify(messages, null, 2));
          }
        }

        // Kill remaining processes
        for (const [role, proc] of runningProcesses) {
          proc.kill("SIGTERM");
          runningProcesses.delete(role);
        }
      },

      async cleanup(): Promise<void> {
        await this.requestShutdown();

        // Write final team summary
        const summary = {
          teamId,
          teamName: config.teamName,
          completedAt: new Date().toISOString(),
          results: results.map((r) => ({
            role: r.role,
            status: r.status,
            durationMs: r.durationMs,
            hasOutput: !!r.output,
          })),
          totalMembers: manifest.members.length,
          succeeded: results.filter((r) => r.status === "completed").length,
          failed: results.filter((r) => r.status === "failed").length,
        };
        writeFileSync(join(teamDir, "summary.json"), JSON.stringify(summary, null, 2));
      },

      getResults(): TeamMemberResult[] {
        // Read from disk for fresh results
        const resultsDir = join(teamDir, "results");
        if (!existsSync(resultsDir)) return [...results];

        const diskResults: TeamMemberResult[] = [];
        for (const file of readdirSync(resultsDir)) {
          if (file.endsWith(".json")) {
            try {
              const content = readFileSync(join(resultsDir, file), "utf-8");
              diskResults.push(JSON.parse(content));
            } catch {
              // Skip malformed files
            }
          }
        }

        return diskResults.length > 0 ? diskResults : [...results];
      },
    };
  },

  /**
   * List all existing teams
   */
  listTeams(): Array<{ teamId: string; teamName: string; createdAt: string; memberCount: number }> {
    if (!existsSync(TEAMS_DIR)) return [];

    const teams: Array<{ teamId: string; teamName: string; createdAt: string; memberCount: number }> = [];

    for (const dir of readdirSync(TEAMS_DIR)) {
      const manifestPath = join(TEAMS_DIR, dir, "manifest.json");
      if (existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
          teams.push({
            teamId: manifest.teamId,
            teamName: manifest.teamName,
            createdAt: manifest.createdAt,
            memberCount: manifest.members?.length || 0,
          });
        } catch {
          // Skip malformed manifests
        }
      }
    }

    return teams;
  },

  /**
   * Get a team by ID (for monitoring/inspection)
   */
  getTeam(teamId: string): { manifest: Record<string, unknown>; results: TeamMemberResult[]; tasks: SharedTask[] } | null {
    const teamDir = join(TEAMS_DIR, teamId);
    if (!existsSync(teamDir)) return null;

    const manifestPath = join(teamDir, "manifest.json");
    const manifest = existsSync(manifestPath)
      ? JSON.parse(readFileSync(manifestPath, "utf-8"))
      : {};

    const resultsDir = join(teamDir, "results");
    const teamResults: TeamMemberResult[] = [];
    if (existsSync(resultsDir)) {
      for (const file of readdirSync(resultsDir)) {
        if (file.endsWith(".json")) {
          try {
            teamResults.push(JSON.parse(readFileSync(join(resultsDir, file), "utf-8")));
          } catch {
            // Skip
          }
        }
      }
    }

    const queuePath = join(teamDir, "tasks", "queue.json");
    const tasks: SharedTask[] = existsSync(queuePath)
      ? JSON.parse(readFileSync(queuePath, "utf-8"))
      : [];

    return { manifest, results: teamResults, tasks };
  },

  /**
   * Get the team inbox messages for a specific member
   */
  getInboxMessages(teamId: string, memberId: string): TeamMessage[] {
    const inboxPath = join(TEAMS_DIR, teamId, "inboxes", memberId, "messages.json");
    if (!existsSync(inboxPath)) return [];
    try {
      return JSON.parse(readFileSync(inboxPath, "utf-8"));
    } catch {
      return [];
    }
  },
};

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main() {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "check": {
      console.log(JSON.stringify({
        available: TeamsBridge.isAvailable(),
        envVar: ENV_FLAG,
        envValue: process.env[ENV_FLAG] || "not set",
      }, null, 2));
      break;
    }

    case "list": {
      const teams = TeamsBridge.listTeams();
      console.log(JSON.stringify(teams, null, 2));
      break;
    }

    case "inspect": {
      const teamId = args[0];
      if (!teamId) {
        console.error("Usage: TeamsBridge.ts inspect <team-id>");
        process.exit(1);
      }
      const team = TeamsBridge.getTeam(teamId);
      if (!team) {
        console.error(`Team not found: ${teamId}`);
        process.exit(1);
      }
      console.log(JSON.stringify(team, null, 2));
      break;
    }

    default:
      console.log(`TeamsBridge - Agent Teams abstraction layer

Commands:
  check              Check if Agent Teams is available
  list               List all teams
  inspect <team-id>  Inspect a team's state and results

Environment:
  ${ENV_FLAG}=1  Enable Agent Teams feature

Usage from TypeScript:
  import { TeamsBridge } from './TeamsBridge.ts';
  if (TeamsBridge.isAvailable()) {
    const team = await TeamsBridge.create({ teamName: 'my-team' });
    // ...
  }`);
  }
}

if (import.meta.main) {
  main().catch(console.error);
}

export default TeamsBridge;
