#!/usr/bin/env bun
/**
 * Chat Listener v3 — Agentic Tool-Use Loop with Conversation Memory
 *
 * Connects to the Kaya daemon via CanvasClient and listens for
 * canvas.chat.send notifications. Routes slash commands locally,
 * then runs an agentic tool-use loop for everything else.
 *
 * The AI gets CanvasClient methods as callable tools, can chain
 * multiple operations per message, and maintains conversation history.
 *
 * Usage:
 *   bun ~/.claude/skills/Development/Canvas/Tools/ChatListener.ts
 */

import { CanvasClient } from './CanvasClient.ts';
import { inference } from '../../../../lib/core/Inference.ts';
import { buildLayout } from './ContainerBuilder.ts';
import type { ContainerSpec } from '../../../../lib/daemon/types.ts';
import { homedir } from 'os';
import { join } from 'path';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

// Clear nested-session guard so inference can spawn claude CLI
delete process.env.CLAUDECODE;

// ============================================================================
// Tool Registry
// ============================================================================

interface ToolDef {
  name: string;
  description: string;
  params: Record<string, string>;
  execute: (client: CanvasClient, params: Record<string, unknown>) => Promise<unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_container',
    description: 'Create a new container on the canvas',
    params: {
      type: 'Container type: markdown, code, terminal, image, chart, list, table',
      title: '(optional) Title for the container',
      content: '(optional) Initial content',
      position: '(optional) {x, y} position. Auto-calculated if omitted.',
    },
    execute: async (client, params) => {
      const type = (params.type as ContainerSpec['type']) ?? 'markdown';
      const title = params.title as string | undefined;
      const content = (params.content as string) ?? '';
      let position = params.position as { x: number; y: number } | undefined;
      if (!position) {
        const layout = await client.snapshotLayout();
        const count = layout.containers?.length ?? 0;
        const col = count % 3;
        const row = Math.floor(count / 3);
        position = { x: col * 420 + 50, y: row * 370 + 50 };
      }
      const result = await client.createContainer({
        type,
        title,
        position,
        props: { content },
      });
      return { id: result.id, type, title: title ?? '(untitled)' };
    },
  },
  {
    name: 'update_container',
    description: 'Update any property of an existing container by ID',
    params: {
      id: 'Container ID to update',
      title: '(optional) New title',
      content: '(optional) New content',
      position: '(optional) New {x, y} position',
      size: '(optional) New {width, height} size',
    },
    execute: async (client, params) => {
      const id = params.id as string;
      if (!id) throw new Error('id is required');
      const partial: Partial<ContainerSpec> = {};
      if (params.title !== undefined) partial.title = params.title as string;
      if (params.position !== undefined) partial.position = params.position as { x: number; y: number };
      if (params.size !== undefined) partial.size = params.size as { width: number; height: number };
      const props: Record<string, unknown> = {};
      if (params.content !== undefined) props.content = params.content;
      if (Object.keys(props).length > 0) partial.props = props;
      const result = await client.updateContainer(id, partial);
      return { id: result.id, updated: true };
    },
  },
  {
    name: 'delete_container',
    description: 'Remove a container from the canvas by ID',
    params: { id: 'Container ID to delete' },
    execute: async (client, params) => {
      const id = params.id as string;
      if (!id) throw new Error('id is required');
      await client.deleteContainer(id);
      return { id, deleted: true };
    },
  },
  {
    name: 'read_container',
    description: 'Read the full content of a container by ID',
    params: { id: 'Container ID to read' },
    execute: async (client, params) => {
      const id = params.id as string;
      if (!id) throw new Error('id is required');
      const result = await client.readContainer(id);
      return { id: result.id, type: result.spec.type, title: result.spec.title, content: result.content };
    },
  },
  {
    name: 'stream_to_container',
    description: 'Append content into an existing container',
    params: {
      id: 'Container ID to stream into',
      content: 'Content to append',
    },
    execute: async (client, params) => {
      const id = params.id as string;
      const content = params.content as string;
      if (!id) throw new Error('id is required');
      const result = await client.streamToContainer(id, content, true);
      return { id: result.id, length: result.length };
    },
  },
  {
    name: 'snapshot_layout',
    description: 'Get all containers on the canvas with their IDs, titles, types, and positions',
    params: {},
    execute: async (client) => {
      const layout = await client.snapshotLayout();
      const containers = (layout.containers ?? []).map((c) => ({
        id: c.id ?? '?',
        title: c.title ?? '(untitled)',
        type: c.type,
        position: c.position,
        size: c.size,
      }));
      return { count: containers.length, containers };
    },
  },
  {
    name: 'apply_layout',
    description: 'Replace the entire canvas layout atomically',
    params: { containers: 'Array of ContainerSpec objects to apply' },
    execute: async (client, params) => {
      const containers = params.containers as ContainerSpec[];
      if (!Array.isArray(containers)) throw new Error('containers must be an array');
      const result = await client.applyLayout(containers);
      return { applied: result.applied, removed: result.removed };
    },
  },
  {
    name: 'build_layout',
    description: 'AI-driven multi-container layout from natural language intent',
    params: { intent: 'Natural language description of desired layout' },
    execute: async (client, params) => {
      const intent = (params.intent as string) ?? '';
      const result = await buildLayout({ intent });
      const specs: ContainerSpec[] = result.specs.map((s) => ({
        type: s.type as ContainerSpec['type'],
        position: { x: s.position.x * 420 + 50, y: s.position.y * 370 + 50 },
        props: s.props,
        title: (s.props.title as string) ?? undefined,
      }));
      await client.applyLayout(specs);
      return { applied: specs.length, intent: result.intent.category };
    },
  },
  {
    name: 'find_container',
    description: 'Find a container by title or type substring match. Returns its ID so you can use it in other tools.',
    params: { match: 'Substring to search for in container titles and types' },
    execute: async (client, params) => {
      const match = params.match as string;
      if (!match) throw new Error('match is required');
      const layout = await client.snapshotLayout();
      const containers = layout.containers ?? [];
      const lower = match.toLowerCase();
      const found = containers.find(
        (c) => c.title?.toLowerCase().includes(lower) || c.type.toLowerCase().includes(lower),
      );
      if (!found) return null;
      return { id: found.id ?? '?', title: found.title ?? '(untitled)', type: found.type };
    },
  },
];

// ============================================================================
// System Prompt (auto-generated from tool registry)
// ============================================================================

function buildSystemPrompt(): string {
  const toolDescriptions = TOOLS.map((t) => {
    const paramList = Object.entries(t.params)
      .map(([name, desc]) => `    ${name}: ${desc}`)
      .join('\n');
    const paramsSection = paramList ? `\n  Parameters:\n${paramList}` : '  (no parameters)';
    return `- ${t.name}: ${t.description}${paramsSection}`;
  }).join('\n\n');

  return `You are Kaya, an AI assistant controlling a Canvas UI. You MUST respond with ONLY a single JSON object — no text before or after, no markdown, no code fences, no explanation.

Either call a tool:
{"type":"tool_call","name":"<tool_name>","params":{...}}

Or give a final response:
{"type":"response","text":"Your message to the user"}

CRITICAL: Output EXACTLY ONE JSON object per response. Nothing else. No prose, no commentary.

Available tools:

${toolDescriptions}

Rules:
- Chain multiple tool calls across turns. After each tool_call, you get the result and can call another or respond.
- Use snapshot_layout and find_container to discover container IDs before updating/deleting.
- For multi-container requests, chain multiple create_container calls or use build_layout.
- Keep response text concise (1-2 sentences). No markdown headers.
- Use conversation history to resolve references like "it", "that note", "the code editor".
- NEVER output both a tool_call and a response in one message. One JSON object only.`;
}

// ============================================================================
// Conversation Memory
// ============================================================================

interface ConversationMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
}

const MAX_HISTORY = 20;
const HISTORY_PATH = join(homedir(), '.claude/MEMORY/canvas-chat-history.json');

let conversationBuffer: ConversationMessage[] = [];

function loadHistory(): void {
  try {
    const raw = readFileSync(HISTORY_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as ConversationMessage[];
    if (Array.isArray(parsed)) {
      conversationBuffer = parsed.slice(-MAX_HISTORY);
    }
  } catch {
    conversationBuffer = [];
  }
}

function persistHistory(): void {
  try {
    const dir = join(homedir(), '.claude/MEMORY');
    mkdirSync(dir, { recursive: true });
    writeFileSync(HISTORY_PATH, JSON.stringify(conversationBuffer, null, 2));
  } catch (err) {
    console.error('[ChatListener] Failed to persist history:', err);
  }
}

function pushMessage(role: ConversationMessage['role'], content: string): void {
  conversationBuffer.push({ role, content, timestamp: Date.now() });
  if (conversationBuffer.length > MAX_HISTORY) {
    conversationBuffer = conversationBuffer.slice(-MAX_HISTORY);
  }
}

function formatHistoryForPrompt(): string {
  if (conversationBuffer.length === 0) return '';
  const lines = conversationBuffer.map((m) => {
    const label = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Kaya' : 'Tool';
    return `[${label}]: ${m.content}`;
  });
  return `Conversation history:\n${lines.join('\n')}`;
}

// ============================================================================
// JSON Extraction (robust — handles text wrapping around JSON)
// ============================================================================

/**
 * Extract the first balanced JSON object from text.
 * Handles models that prefix/suffix JSON with prose.
 */
function extractFirstJson(text: string): AgentResponse | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
          if (parsed.type === 'tool_call' || parsed.type === 'response') {
            return parsed as AgentResponse;
          }
        } catch { /* not valid JSON, keep scanning */ }
      }
    }
  }
  return null;
}

// ============================================================================
// Agentic Loop
// ============================================================================

const MAX_TOOL_CALLS = 8;

interface ToolCallResponse {
  type: 'tool_call';
  name: string;
  params: Record<string, unknown>;
}

interface TextResponse {
  type: 'response';
  text: string;
}

type AgentResponse = ToolCallResponse | TextResponse;

async function agenticLoop(client: CanvasClient, userMessage: string): Promise<void> {
  // Show typing indicator
  client.sendChatResponse('...', true);

  // Push user message to conversation buffer
  pushMessage('user', userMessage);

  // Get layout context
  const layoutContext = await getLayoutContext(client);

  // Build turn context (accumulates tool call/results within this turn)
  const turnContext: string[] = [];
  const systemPrompt = buildSystemPrompt();

  for (let iteration = 0; iteration < MAX_TOOL_CALLS; iteration++) {
    // Build full prompt
    const historyBlock = formatHistoryForPrompt();
    const turnBlock = turnContext.length > 0
      ? `\nTool calls this turn:\n${turnContext.join('\n')}`
      : '';
    const userPrompt = `${layoutContext}\n\n${historyBlock}${turnBlock}\n\nUser message: ${userMessage}`;

    const result = await inference({
      systemPrompt,
      userPrompt,
      level: 'standard',
      expectJson: false,
    });

    if (!result.success) {
      client.sendChatResponse(`Inference error: ${result.error ?? 'unknown'}`);
      persistHistory();
      return;
    }

    // Extract first valid JSON object (handles prose wrapping)
    const response = extractFirstJson(result.output ?? '');
    if (!response) {
      // No valid JSON found — send raw output as fallback
      const fallback = result.output?.trim();
      if (fallback) {
        client.sendChatResponse(fallback);
        pushMessage('assistant', fallback);
      } else {
        client.sendChatResponse('I had trouble processing that. Try again?');
      }
      persistHistory();
      return;
    }

    // Final text response — send to chat and exit loop
    if (response.type === 'response') {
      const text = response.text ?? '';
      client.sendChatResponse(text);
      pushMessage('assistant', text);
      persistHistory();
      return;
    }

    // Tool call — execute and loop
    if (response.type === 'tool_call') {
      const toolDef = TOOLS.find((t) => t.name === response.name);
      if (!toolDef) {
        const errMsg = `Unknown tool: ${response.name}`;
        turnContext.push(`[tool_call: ${response.name}] -> Error: ${errMsg}`);
        continue;
      }

      try {
        const toolResult = await toolDef.execute(client, response.params ?? {});
        const resultStr = JSON.stringify(toolResult);
        turnContext.push(`[tool_call: ${response.name}(${JSON.stringify(response.params)})] -> ${resultStr}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        turnContext.push(`[tool_call: ${response.name}(${JSON.stringify(response.params)})] -> Error: ${errMsg}`);
      }
      continue;
    }

    // Unrecognized response shape — treat as text
    const rawText = result.output?.trim() ?? 'I had trouble processing that.';
    client.sendChatResponse(rawText);
    pushMessage('assistant', rawText);
    persistHistory();
    return;
  }

  // Max iterations reached — summarize what happened
  const summary = `Completed ${MAX_TOOL_CALLS} operations. Check the canvas for results.`;
  client.sendChatResponse(summary);
  pushMessage('assistant', summary);
  persistHistory();
}

// ============================================================================
// Layout Context
// ============================================================================

async function getLayoutContext(client: CanvasClient): Promise<string> {
  try {
    const layout = await client.snapshotLayout();
    const containers = layout.containers ?? [];
    if (containers.length === 0) {
      return 'Current Canvas: empty (no containers)';
    }
    const lines = containers.map((c) => {
      const title = c.title ?? '(untitled)';
      const id = c.id ?? '?';
      const size = c.size ? ` size=${c.size.width}x${c.size.height}` : '';
      return `- "${title}" (${c.type}, id=${id}) at ${c.position.x},${c.position.y}${size}`;
    });
    return `Current Canvas layout:\n${lines.join('\n')}`;
  } catch {
    return 'Current Canvas: unable to read layout';
  }
}

// ============================================================================
// Slash Commands
// ============================================================================

interface SlashCommandResult {
  message: string;
}

type SlashCommandHandler = (client: CanvasClient, args: string) => Promise<SlashCommandResult>;

const slashCommands: Record<string, SlashCommandHandler> = {
  '/clear': async (client) => {
    await client.applyLayout([], []);
    return { message: 'Canvas cleared — all containers removed.' };
  },

  '/snapshot': async (client) => {
    const layout = await client.snapshotLayout();
    const count = layout.containers?.length ?? 0;
    const pipes = layout.pipes?.length ?? 0;
    return { message: `Layout snapshot: ${count} container${count !== 1 ? 's' : ''}, ${pipes} pipe${pipes !== 1 ? 's' : ''}` };
  },

  '/ping': async (client) => {
    const { latency } = await client.ping();
    return { message: `Pong — ${latency}ms round-trip to daemon.` };
  },

  '/clear-history': async () => {
    conversationBuffer = [];
    persistHistory();
    return { message: 'Conversation history cleared.' };
  },

  '/help': async () => {
    return {
      message: [
        'Available commands:',
        '  /clear          — Remove all containers from Canvas',
        '  /clear-history  — Reset conversation memory',
        '  /snapshot       — Show current layout summary',
        '  /ping           — Check connection latency',
        '  /help           — Show this message',
        '',
        'Or just type naturally — Kaya can create, update, delete, read, and chain multiple operations.',
      ].join('\n'),
    };
  },
};

// ============================================================================
// Message Handler
// ============================================================================

async function handleMessage(client: CanvasClient, message: string): Promise<void> {
  const trimmed = message.trim();
  if (!trimmed) return;

  // Route slash commands
  if (trimmed.startsWith('/')) {
    const spaceIdx = trimmed.indexOf(' ');
    const cmd = spaceIdx === -1 ? trimmed.toLowerCase() : trimmed.slice(0, spaceIdx).toLowerCase();
    const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

    const handler = slashCommands[cmd];
    if (handler) {
      try {
        const result = await handler(client, args);
        client.sendChatResponse(result.message);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        client.sendChatResponse(`Error running ${cmd}: ${msg}`);
      }
      return;
    }
    // Unknown slash command — fall through to AI
  }

  // Agentic tool-use loop
  try {
    await agenticLoop(client, trimmed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    client.sendChatResponse(`Error: ${msg}`);
  }
}

// ============================================================================
// Main
// ============================================================================

if (import.meta.main) {
  // Load persisted conversation history
  loadHistory();
  console.log(`[ChatListener v3] Loaded ${conversationBuffer.length} messages from history`);

  const client = new CanvasClient();

  try {
    await client.connect();
  } catch (err) {
    console.error('Failed to connect to daemon:', err);
    process.exit(1);
  }

  console.log('[ChatListener v3] Connected — agentic tool-use loop active');

  client.onChatMessage(async (msg) => {
    await handleMessage(client, msg.message);
  });

  process.on('SIGINT', () => {
    console.log('[ChatListener v3] Shutting down');
    persistHistory();
    client.destroy();
    process.exit(0);
  });
}
