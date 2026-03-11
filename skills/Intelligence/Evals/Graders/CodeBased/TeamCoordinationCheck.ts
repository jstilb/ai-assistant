/**
 * Team Coordination Check Grader
 * Evaluates quality of multi-agent team coordination
 *
 * Checks: message latency, task dependency respect,
 * communication efficiency, and deadlock detection.
 * Score 0-1 based on weighted criteria.
 */

import { BaseGrader, registerGrader, type GraderContext } from '../Base.ts';
import type { GraderConfig, GraderResult } from '../../Types/index.ts';

export interface TeamCoordinationParams {
  /** Max acceptable message latency in ms (default: 5000) */
  max_message_latency_ms?: number;
  /** Max messages per unit of progress before flagging inefficiency (default: 20) */
  max_messages_per_progress?: number;
  /** Deadlock timeout: max time with no progress in ms (default: 30000) */
  deadlock_timeout_ms?: number;
  /** Weight for message latency score (default: 0.25) */
  weight_latency?: number;
  /** Weight for task dependency respect score (default: 0.30) */
  weight_dependency?: number;
  /** Weight for communication efficiency score (default: 0.25) */
  weight_efficiency?: number;
  /** Weight for deadlock detection score (default: 0.20) */
  weight_deadlock?: number;
}

interface TeamMessage {
  from: string;
  to: string;
  content: string;
  timestamp: string;
}

interface TaskUpdate {
  taskId: string;
  status: string;
  assignedTo?: string;
  updatedAt: string;
  dependsOn?: string[];
}

export class TeamCoordinationCheckGrader extends BaseGrader {
  type = 'team_coordination' as const;
  category = 'code_based' as const;

  async grade(context: GraderContext): Promise<GraderResult> {
    const start = performance.now();
    const params = (this.config.params || {}) as TeamCoordinationParams;

    const maxLatency = params.max_message_latency_ms ?? 5000;
    const maxMsgsPerProgress = params.max_messages_per_progress ?? 20;
    const deadlockTimeout = params.deadlock_timeout_ms ?? 30000;
    const wLatency = params.weight_latency ?? 0.25;
    const wDependency = params.weight_dependency ?? 0.30;
    const wEfficiency = params.weight_efficiency ?? 0.25;
    const wDeadlock = params.weight_deadlock ?? 0.20;

    // Extract team data from transcript
    const teamMessages = this.extractTeamMessages(context);
    const taskUpdates = this.extractTaskUpdates(context);

    // Score each criterion (0-1)
    const latencyScore = this.scoreMessageLatency(teamMessages, maxLatency);
    const dependencyScore = this.scoreTaskDependencyRespect(taskUpdates);
    const efficiencyScore = this.scoreCommunicationEfficiency(teamMessages, taskUpdates, maxMsgsPerProgress);
    const deadlockScore = this.scoreDeadlockDetection(teamMessages, taskUpdates, deadlockTimeout);

    // Weighted aggregate
    const score = (
      latencyScore * wLatency +
      dependencyScore * wDependency +
      efficiencyScore * wEfficiency +
      deadlockScore * wDeadlock
    );

    const passed = score >= 0.5;

    return this.createResult(score, passed, performance.now() - start, {
      reasoning: `Team coordination score: ${(score * 100).toFixed(1)}% ` +
        `(latency: ${(latencyScore * 100).toFixed(0)}%, ` +
        `dependencies: ${(dependencyScore * 100).toFixed(0)}%, ` +
        `efficiency: ${(efficiencyScore * 100).toFixed(0)}%, ` +
        `deadlock-free: ${(deadlockScore * 100).toFixed(0)}%)`,
      details: {
        latency_score: latencyScore,
        dependency_score: dependencyScore,
        efficiency_score: efficiencyScore,
        deadlock_score: deadlockScore,
        total_messages: teamMessages.length,
        total_task_updates: taskUpdates.length,
        weights: { latency: wLatency, dependency: wDependency, efficiency: wEfficiency, deadlock: wDeadlock },
      },
    });
  }

  /**
   * Extract team messages from transcript tool calls and output
   */
  private extractTeamMessages(context: GraderContext): TeamMessage[] {
    const messages: TeamMessage[] = [];

    // Check transcript for team message data in tool calls
    if (context.transcript?.tool_calls) {
      for (const tc of context.transcript.tool_calls) {
        if (tc.name === 'SendMessage' || tc.name === 'team_send' || tc.name === 'broadcast') {
          messages.push({
            from: (tc.params?.from as string) || 'unknown',
            to: (tc.params?.to as string) || (tc.params?.recipient as string) || 'all',
            content: (tc.params?.content as string) || '',
            timestamp: tc.started_at || new Date().toISOString(),
          });
        }
      }
    }

    // Check for team_messages in final_outcome
    const outcome = context.transcript?.final_outcome as Record<string, unknown> | undefined;
    if (outcome?.team_messages && Array.isArray(outcome.team_messages)) {
      for (const msg of outcome.team_messages) {
        if (msg && typeof msg === 'object' && 'from' in msg) {
          messages.push(msg as TeamMessage);
        }
      }
    }

    return messages;
  }

  /**
   * Extract task updates from transcript
   */
  private extractTaskUpdates(context: GraderContext): TaskUpdate[] {
    const updates: TaskUpdate[] = [];

    if (context.transcript?.tool_calls) {
      for (const tc of context.transcript.tool_calls) {
        if (tc.name === 'TaskUpdate' || tc.name === 'team_task_update') {
          updates.push({
            taskId: (tc.params?.taskId as string) || (tc.params?.id as string) || 'unknown',
            status: (tc.params?.status as string) || 'unknown',
            assignedTo: tc.params?.assignedTo as string | undefined,
            updatedAt: tc.started_at || new Date().toISOString(),
            dependsOn: tc.params?.dependsOn as string[] | undefined,
          });
        }
      }
    }

    return updates;
  }

  /**
   * Score message latency: how quickly are messages responded to?
   * Returns 1.0 for all messages under threshold, degrades linearly.
   */
  private scoreMessageLatency(messages: TeamMessage[], maxLatencyMs: number): number {
    if (messages.length < 2) return 1.0; // Not enough data, assume good

    // Group messages by conversation pairs and measure response times
    const sorted = [...messages].sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    let totalLatency = 0;
    let latencyCount = 0;

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      // If this is a response (different sender, same direction)
      if (curr.from !== prev.from) {
        const latency = new Date(curr.timestamp).getTime() - new Date(prev.timestamp).getTime();
        totalLatency += latency;
        latencyCount++;
      }
    }

    if (latencyCount === 0) return 1.0;

    const avgLatency = totalLatency / latencyCount;
    if (avgLatency <= maxLatencyMs) return 1.0;
    if (avgLatency >= maxLatencyMs * 5) return 0.0;

    // Linear degradation between 1x and 5x threshold
    return 1.0 - ((avgLatency - maxLatencyMs) / (maxLatencyMs * 4));
  }

  /**
   * Score task dependency respect: are tasks started only after dependencies complete?
   * Returns 1.0 if all dependencies respected, 0 for each violation.
   */
  private scoreTaskDependencyRespect(updates: TaskUpdate[]): number {
    if (updates.length === 0) return 1.0;

    const completedTasks = new Set<string>();
    let violations = 0;
    let totalDependencyChecks = 0;

    for (const update of updates) {
      if (update.status === 'completed') {
        completedTasks.add(update.taskId);
      }

      if (update.status === 'in_progress' && update.dependsOn) {
        for (const dep of update.dependsOn) {
          totalDependencyChecks++;
          if (!completedTasks.has(dep)) {
            violations++;
          }
        }
      }
    }

    if (totalDependencyChecks === 0) return 1.0;
    return Math.max(0, 1.0 - (violations / totalDependencyChecks));
  }

  /**
   * Score communication efficiency: messages sent vs. progress made
   * Too many messages relative to task completions indicates inefficiency.
   */
  private scoreCommunicationEfficiency(
    messages: TeamMessage[],
    taskUpdates: TaskUpdate[],
    maxMsgsPerProgress: number
  ): number {
    const completions = taskUpdates.filter(u => u.status === 'completed').length;
    if (completions === 0 && messages.length === 0) return 1.0;
    if (completions === 0 && messages.length > 0) return 0.2; // Messages but no progress

    const ratio = messages.length / Math.max(completions, 1);
    if (ratio <= maxMsgsPerProgress) return 1.0;
    if (ratio >= maxMsgsPerProgress * 3) return 0.0;

    return 1.0 - ((ratio - maxMsgsPerProgress) / (maxMsgsPerProgress * 2));
  }

  /**
   * Score deadlock detection: look for periods of no progress with active messaging.
   * Deadlock = messages being sent but no task status changes for extended period.
   */
  private scoreDeadlockDetection(
    messages: TeamMessage[],
    taskUpdates: TaskUpdate[],
    deadlockTimeoutMs: number
  ): number {
    if (messages.length === 0 && taskUpdates.length === 0) return 1.0;

    // Build timeline of all events
    const events: { time: number; type: 'message' | 'progress' }[] = [];

    for (const msg of messages) {
      events.push({ time: new Date(msg.timestamp).getTime(), type: 'message' });
    }
    for (const update of taskUpdates) {
      if (update.status === 'completed' || update.status === 'in_progress') {
        events.push({ time: new Date(update.updatedAt).getTime(), type: 'progress' });
      }
    }

    events.sort((a, b) => a.time - b.time);

    // Check for periods with messages but no progress
    let lastProgressTime = events.length > 0 ? events[0].time : 0;
    let deadlockDetected = false;

    for (const event of events) {
      if (event.type === 'progress') {
        lastProgressTime = event.time;
      } else if (event.type === 'message') {
        const timeSinceProgress = event.time - lastProgressTime;
        if (timeSinceProgress > deadlockTimeoutMs) {
          deadlockDetected = true;
          break;
        }
      }
    }

    return deadlockDetected ? 0.0 : 1.0;
  }
}

registerGrader('team_coordination', TeamCoordinationCheckGrader);
