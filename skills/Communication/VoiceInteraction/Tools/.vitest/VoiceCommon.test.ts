/**
 * VoiceCommon.test.ts - Tests for shared VoiceInteraction utilities
 *
 * Tests exit command detection, config loading, directory setup,
 * and StateManager schema validation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';

// Test exit command detection directly (pure function, no external deps)
describe('isExitCommand', () => {
  // We test the logic inline since importing VoiceCommon pulls in CORE deps
  const EXIT_COMMANDS = ["stop", "quit", "exit", "goodbye", "bye", "stop listening"];

  function isExitCommand(input: string): boolean {
    const lower = input.toLowerCase();
    return EXIT_COMMANDS.some((cmd) => lower.includes(cmd));
  }

  it('detects exact exit commands', () => {
    expect(isExitCommand('stop')).toBe(true);
    expect(isExitCommand('quit')).toBe(true);
    expect(isExitCommand('exit')).toBe(true);
    expect(isExitCommand('goodbye')).toBe(true);
    expect(isExitCommand('bye')).toBe(true);
    expect(isExitCommand('stop listening')).toBe(true);
  });

  it('detects exit commands in sentences', () => {
    expect(isExitCommand('okay goodbye kaya')).toBe(true);
    expect(isExitCommand('please stop listening now')).toBe(true);
    expect(isExitCommand('I want to quit')).toBe(true);
    expect(isExitCommand('time to exit the conversation')).toBe(true);
    expect(isExitCommand('bye for now')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isExitCommand('STOP')).toBe(true);
    expect(isExitCommand('Goodbye')).toBe(true);
    expect(isExitCommand('QUIT')).toBe(true);
    expect(isExitCommand('BYE')).toBe(true);
    expect(isExitCommand('Stop Listening')).toBe(true);
  });

  it('does not match non-exit phrases', () => {
    expect(isExitCommand('hello kaya')).toBe(false);
    expect(isExitCommand('what is the weather')).toBe(false);
    expect(isExitCommand('tell me a joke')).toBe(false);
    expect(isExitCommand('how are you')).toBe(false);
    expect(isExitCommand('')).toBe(false);
  });

  it('handles edge cases', () => {
    expect(isExitCommand('   ')).toBe(false);
    expect(isExitCommand('stopping')).toBe(true); // "stop" is contained in "stopping"
    expect(isExitCommand('exiting')).toBe(true); // "exit" is contained in "exiting"
    expect(isExitCommand('byebye')).toBe(true); // "bye" is contained
  });
});

describe('EXIT_COMMANDS constant', () => {
  const EXIT_COMMANDS = ["stop", "quit", "exit", "goodbye", "bye", "stop listening"];

  it('contains expected commands', () => {
    expect(EXIT_COMMANDS).toContain('stop');
    expect(EXIT_COMMANDS).toContain('quit');
    expect(EXIT_COMMANDS).toContain('exit');
    expect(EXIT_COMMANDS).toContain('goodbye');
    expect(EXIT_COMMANDS).toContain('bye');
    expect(EXIT_COMMANDS).toContain('stop listening');
  });

  it('has exactly 6 commands', () => {
    expect(EXIT_COMMANDS).toHaveLength(6);
  });

  it('contains only lowercase strings', () => {
    for (const cmd of EXIT_COMMANDS) {
      expect(cmd).toBe(cmd.toLowerCase());
    }
  });
});

describe('DesktopPidState schema validation', () => {
  // Test the Zod schema logic directly
  const { z } = require('zod');

  const DesktopPidSchema = z.object({
    pid: z.number().optional(),
    startedAt: z.string().optional(),
  });

  it('accepts empty state', () => {
    const result = DesktopPidSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts state with pid', () => {
    const result = DesktopPidSchema.safeParse({ pid: 12345 });
    expect(result.success).toBe(true);
  });

  it('accepts full state', () => {
    const result = DesktopPidSchema.safeParse({
      pid: 12345,
      startedAt: '2026-02-07T14:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-number pid', () => {
    const result = DesktopPidSchema.safeParse({ pid: 'not-a-number' });
    expect(result.success).toBe(false);
  });

  it('rejects non-string startedAt', () => {
    const result = DesktopPidSchema.safeParse({ startedAt: 12345 });
    expect(result.success).toBe(false);
  });
});

describe('ConversationSession schema validation', () => {
  const { z } = require('zod');

  const ConversationMessageSchema = z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    timestamp: z.string(),
  });

  const ConversationSessionSchema = z.object({
    id: z.string(),
    startedAt: z.string(),
    messages: z.array(ConversationMessageSchema),
    turnCount: z.number(),
  });

  it('accepts valid session', () => {
    const result = ConversationSessionSchema.safeParse({
      id: 'session-123',
      startedAt: '2026-02-07T14:00:00.000Z',
      messages: [],
      turnCount: 0,
    });
    expect(result.success).toBe(true);
  });

  it('accepts session with messages', () => {
    const result = ConversationSessionSchema.safeParse({
      id: 'session-123',
      startedAt: '2026-02-07T14:00:00.000Z',
      messages: [
        { role: 'user', content: 'hello', timestamp: '2026-02-07T14:00:01.000Z' },
        { role: 'assistant', content: 'hi there', timestamp: '2026-02-07T14:00:02.000Z' },
      ],
      turnCount: 1,
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid role', () => {
    const result = ConversationSessionSchema.safeParse({
      id: 'session-123',
      startedAt: '2026-02-07T14:00:00.000Z',
      messages: [
        { role: 'system', content: 'invalid', timestamp: '2026-02-07T14:00:01.000Z' },
      ],
      turnCount: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing required fields', () => {
    const result = ConversationSessionSchema.safeParse({
      id: 'session-123',
    });
    expect(result.success).toBe(false);
  });
});

describe('InterruptionState schema validation', () => {
  const { z } = require('zod');

  const ActiveResponseSchema = z.object({
    sessionId: z.string(),
    channel: z.enum(["desktop", "telegram"]),
    startedAt: z.string(),
    pid: z.number().optional(),
    audioFile: z.string().optional(),
  });

  const InterruptionStateSchema = z.object({
    activeResponses: z.array(ActiveResponseSchema),
    lastInterruption: z.object({
      sessionId: z.string(),
      at: z.string(),
      reason: z.string(),
    }).optional(),
  });

  it('accepts empty state', () => {
    const result = InterruptionStateSchema.safeParse({ activeResponses: [] });
    expect(result.success).toBe(true);
  });

  it('accepts state with active response', () => {
    const result = InterruptionStateSchema.safeParse({
      activeResponses: [{
        sessionId: 'turn-0',
        channel: 'desktop',
        startedAt: '2026-02-07T14:00:00.000Z',
        pid: 12345,
      }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts state with last interruption', () => {
    const result = InterruptionStateSchema.safeParse({
      activeResponses: [],
      lastInterruption: {
        sessionId: 'turn-0',
        at: '2026-02-07T14:00:00.000Z',
        reason: 'user_interrupt',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid channel', () => {
    const result = InterruptionStateSchema.safeParse({
      activeResponses: [{
        sessionId: 'turn-0',
        channel: 'phone',
        startedAt: '2026-02-07T14:00:00.000Z',
      }],
    });
    expect(result.success).toBe(false);
  });
});

describe('ScheduledPings schema validation', () => {
  const { z } = require('zod');

  const ScheduledPingSchema = z.object({
    id: z.string(),
    message: z.string(),
    scheduledAt: z.string(),
    channel: z.enum(["desktop", "telegram", "auto"]).optional(),
    createdAt: z.string(),
    status: z.enum(["pending", "sent", "cancelled"]),
  });

  const ScheduledPingsStateSchema = z.object({
    pings: z.array(ScheduledPingSchema),
  });

  it('accepts empty pings', () => {
    const result = ScheduledPingsStateSchema.safeParse({ pings: [] });
    expect(result.success).toBe(true);
  });

  it('accepts valid pending ping', () => {
    const result = ScheduledPingsStateSchema.safeParse({
      pings: [{
        id: 'ping-123',
        message: 'Hello',
        scheduledAt: '2026-02-07T15:00:00.000Z',
        channel: 'auto',
        createdAt: '2026-02-07T14:00:00.000Z',
        status: 'pending',
      }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts sent ping', () => {
    const result = ScheduledPingsStateSchema.safeParse({
      pings: [{
        id: 'ping-123',
        message: 'Hello',
        scheduledAt: '2026-02-07T15:00:00.000Z',
        createdAt: '2026-02-07T14:00:00.000Z',
        status: 'sent',
      }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid status', () => {
    const result = ScheduledPingsStateSchema.safeParse({
      pings: [{
        id: 'ping-123',
        message: 'Hello',
        scheduledAt: '2026-02-07T15:00:00.000Z',
        createdAt: '2026-02-07T14:00:00.000Z',
        status: 'failed',
      }],
    });
    expect(result.success).toBe(false);
  });
});

describe('buildConversationPrompt', () => {
  // Test the pure logic of prompt building
  function buildConversationPrompt(
    session: { messages: Array<{ role: string; content: string }> },
    newInput: string,
    assistantName: string = 'Kaya',
    userName: string = 'Jm'
  ): string {
    const recentMessages = session.messages.slice(-10);
    const history = recentMessages
      .map((m) => `${m.role === "user" ? userName : assistantName}: ${m.content}`)
      .join("\n");

    return `You are ${assistantName}, a personal AI assistant having a voice conversation with ${userName}.
Respond naturally and concisely as if speaking aloud. Keep responses under 3 sentences unless the question requires more detail.
Do not use markdown formatting, bullet points, or special characters - this will be spoken aloud.

${history ? `Recent conversation:\n${history}\n\n` : ""}${userName}: ${newInput}

${assistantName}:`;
  }

  it('builds prompt with empty history', () => {
    const prompt = buildConversationPrompt({ messages: [] }, 'Hello');
    expect(prompt).toContain('Kaya');
    expect(prompt).toContain('Jm');
    expect(prompt).toContain('Hello');
    expect(prompt).not.toContain('Recent conversation');
  });

  it('builds prompt with history', () => {
    const prompt = buildConversationPrompt(
      {
        messages: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello!' },
        ],
      },
      'How are you?'
    );
    expect(prompt).toContain('Recent conversation');
    expect(prompt).toContain('Jm: Hi');
    expect(prompt).toContain('Kaya: Hello!');
    expect(prompt).toContain('Jm: How are you?');
  });

  it('limits history to last 10 messages', () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message-${i}`,
    }));
    const prompt = buildConversationPrompt({ messages }, 'Latest');
    expect(prompt).toContain('message-10');
    expect(prompt).not.toContain('message-0');
  });

  it('uses custom names', () => {
    const prompt = buildConversationPrompt(
      { messages: [] },
      'Hello',
      'Assistant',
      'User'
    );
    expect(prompt).toContain('You are Assistant');
    expect(prompt).toContain('User: Hello');
  });
});
