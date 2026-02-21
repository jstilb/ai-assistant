import { describe, test, expect } from "bun:test";
import {
  loadSession,
  recordExchange,
  formatSessionContext,
} from "./SessionManager";

// These tests use the real SESSIONS_DIR (~/.claude/MEMORY/TELEGRAM/sessions)
// but use unique channel IDs to avoid collisions.
const TEST_PREFIX = `test-${Date.now()}`;

describe("SessionManager", () => {
  test("loadSession creates new session when none exists", async () => {
    const channelId = `${TEST_PREFIX}-new`;
    const session = await loadSession(channelId);

    expect(session).toBeDefined();
    expect(session.channelId).toBe(channelId);
    expect(session.sessionId).toContain(channelId);
    expect(session.exchangeCount).toBe(0);
    expect(session.recentExchanges).toEqual([]);
    expect(session.summary).toBe("");
    expect(session.currentProfile).toBe("general");
  });

  test("loadSession continues existing session within 6 hours", async () => {
    const channelId = `${TEST_PREFIX}-continue`;

    // Create a session first
    const session1 = await loadSession(channelId);
    await recordExchange(session1, {
      timestamp: new Date().toISOString(),
      userText: "Hello",
      assistantText: "Hi there!",
      source: "text",
      profile: "general",
    });

    // Load again - should continue the same session
    const session2 = await loadSession(channelId);
    expect(session2.sessionId).toBe(session1.sessionId);
    expect(session2.exchangeCount).toBe(1);
  });

  test("recordExchange increments count and stores in recentExchanges", async () => {
    const channelId = `${TEST_PREFIX}-record`;
    const session = await loadSession(channelId);

    const exchange = {
      timestamp: new Date().toISOString(),
      userText: "What's the weather?",
      assistantText: "It's sunny today.",
      voiceLine: "It's sunny today.",
      source: "text" as const,
      profile: "general",
    };

    const updated = await recordExchange(session, exchange);

    expect(updated.exchangeCount).toBe(1);
    expect(updated.recentExchanges).toHaveLength(1);
    expect(updated.recentExchanges[0].userText).toBe("What's the weather?");

    // Verify persistence by reloading
    const reloaded = await loadSession(channelId);
    expect(reloaded.exchangeCount).toBe(1);
    expect(reloaded.recentExchanges).toHaveLength(1);
    expect(reloaded.recentExchanges[0].userText).toBe("What's the weather?");
  });

  test("formatSessionContext formats summary and recent exchanges", () => {
    const session = {
      sessionId: "test-123",
      channelId: "chan-1",
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      exchangeCount: 2,
      summary: "User asked about weather and recipes.",
      recentExchanges: [
        {
          timestamp: new Date().toISOString(),
          userText: "Hello",
          assistantText: "Hi there!",
          source: "text" as const,
          profile: "general",
        },
        {
          timestamp: new Date().toISOString(),
          userText: "How are you?",
          assistantText: "I'm doing well!",
          source: "text" as const,
          profile: "general",
        },
      ],
      currentProfile: "general",
      forceSummarized: false,
    };

    const context = formatSessionContext(session);

    expect(context).toContain("## Conversation Summary");
    expect(context).toContain("User asked about weather and recipes.");
    expect(context).toContain("## Recent Messages");
    expect(context).toContain("Hello");
    expect(context).toContain("Hi there!");
    expect(context).toContain("How are you?");
    expect(context).toContain("I'm doing well!");
  });

  test("formatSessionContext handles empty session", () => {
    const session = {
      sessionId: "empty-session",
      channelId: "chan-1",
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      exchangeCount: 0,
      summary: "",
      recentExchanges: [],
      currentProfile: "general",
      forceSummarized: false,
    };

    const context = formatSessionContext(session);
    expect(context).toBe("");
  });
});
