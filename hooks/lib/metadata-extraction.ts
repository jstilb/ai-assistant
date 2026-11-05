#!/usr/bin/env bun
/**
 * Metadata Extraction Library for UOCS Enhancement
 *
 * Extracts agent instance IDs, parent-child relationships, and session info
 * from Task tool calls and other tool inputs.
 *
 * Design Philosophy: Optional extraction with graceful fallbacks
 * - If instance IDs are present in descriptions/prompts, extract them
 * - If not present, fall back to agent type only
 * - Never fail - always return usable metadata
 */

/** The fields of a Task tool input that this module reads. Other fields are allowed and ignored. */
export interface AgentToolInput {
  prompt?: unknown;
  subagent_type?: unknown;
  [key: string]: unknown;
}

interface AgentInstanceMetadata {
  agent_instance_id?: string; // "perplexity-researcher-1" (full ID)
  agent_type?: string; // "perplexity-researcher" (base type)
  instance_number?: number; // 1 (sequence number)
  parent_session_id?: string; // Session that spawned this agent
  parent_task_id?: string; // Task ID that spawned this agent
}

/**
 * Extract agent instance ID from Task tool input
 *
 * Looks for patterns in priority order:
 * 1. [agent-type-N] in description (e.g., "Research topic [perplexity-researcher-1]")
 * 2. [AGENT_INSTANCE: agent-type-N] in prompt
 * 3. subagent_type field (fallback to just type, no instance number)
 *
 * @param toolInput The tool input object from PreToolUse/PostToolUse hooks
 * @param description Optional description field from tool input
 * @returns Metadata object with extracted information
 */
export function extractAgentInstanceId(
  toolInput: AgentToolInput | null | undefined,
  description?: string,
): AgentInstanceMetadata {
  const result: AgentInstanceMetadata = {};

  // Strategy 1: Extract from description [agent-type-N]
  // Example: "Research consumer complaints [perplexity-researcher-1]"
  if (description) {
    const descMatch = description.match(/\[([a-z-]+-researcher)-(\d+)\]/);
    if (descMatch) {
      result.agent_type = descMatch[1];
      result.instance_number = parseInt(descMatch[2] ?? "", 10);
      result.agent_instance_id = `${result.agent_type}-${result.instance_number}`;
    }
  }

  // Strategy 2: Extract from prompt [AGENT_INSTANCE: ...]
  // Example: "[AGENT_INSTANCE: perplexity-researcher-1]"
  if (!result.agent_instance_id && toolInput?.prompt && typeof toolInput.prompt === "string") {
    const promptMatch = toolInput.prompt.match(/\[AGENT_INSTANCE:\s*([^\]]+)\]/);
    if (promptMatch) {
      const instanceId = (promptMatch[1] ?? "").trim();
      result.agent_instance_id = instanceId;

      // Parse agent type and instance number from ID
      const parts = instanceId.match(/^([a-z-]+)-(\d+)$/);
      if (parts) {
        result.agent_type = parts[1];
        result.instance_number = parseInt(parts[2] ?? "", 10);
      }
    }
  }

  // Strategy 3: Extract parent session from prompt
  // Example: "[PARENT_SESSION: b7062b5a-03d3-4168-9555-a748e0b2efa3]"
  if (toolInput?.prompt && typeof toolInput.prompt === "string") {
    const parentSessionMatch = toolInput.prompt.match(/\[PARENT_SESSION:\s*([^\]]+)\]/);
    if (parentSessionMatch) {
      result.parent_session_id = (parentSessionMatch[1] ?? "").trim();
    }

    // Extract parent task from prompt
    // Example: "[PARENT_TASK: research_1731445892345]"
    const parentTaskMatch = toolInput.prompt.match(/\[PARENT_TASK:\s*([^\]]+)\]/);
    if (parentTaskMatch) {
      result.parent_task_id = (parentTaskMatch[1] ?? "").trim();
    }
  }

  // Strategy 4: Fallback to subagent_type if available (no instance number)
  // This ensures we at least capture the agent type even without instance IDs
  if (!result.agent_type && typeof toolInput?.subagent_type === "string" && toolInput.subagent_type) {
    result.agent_type = toolInput.subagent_type;
  }

  return result;
}
