#!/usr/bin/env bun
/**
 * OutreachState.ts - JSONL-backed CRM Pipeline State Manager
 *
 * Manages the outreach contact pipeline using JSONL format for
 * append-friendly, grep-friendly storage.
 *
 * INFRASTRUCTURE NOTE: Uses Node fs APIs (readFileSync/writeFileSync/appendFileSync)
 * instead of CORE StateManager because StateManager is JSON-backed and does not
 * support JSONL (one JSON object per line). JSONL is required here for efficient
 * append-only writes and line-oriented grep. This is a domain-specific state manager.
 *
 * Features:
 *   - CRUD operations for contact records
 *   - Pipeline stage management (discovered -> connected)
 *   - Search by name, community, stage, tag
 *   - Filter by relevance score threshold
 *   - Weekly outreach rate limiting
 *   - Deduplication by email and name+source
 *   - JSONL format for efficient append and grep
 *
 * Usage:
 *   bun OutreachState.ts add --name "Person" --community "professional-ai" --source "conference-speaker"
 *   bun OutreachState.ts update --id "uuid" --stage "profiled" --email "person@email.com"
 *   bun OutreachState.ts search --query "AI" [--community "professional-ai"] [--stage "discovered"]
 *   bun OutreachState.ts list [--stage "discovered"] [--community "professional-ai"] [--min-score 0.5]
 *   bun OutreachState.ts get --id "uuid"
 *   bun OutreachState.ts summary
 *   bun OutreachState.ts rate-check
 *   bun OutreachState.ts --test
 *
 * @module OutreachState
 * @version 1.0.0
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";

// ============================================
// TYPES
// ============================================

export type OutreachStage =
  | "discovered"
  | "profiled"
  | "drafted"
  | "sent"
  | "responded"
  | "connected"
  | "opted-out";

export interface OutreachContact {
  id: string;
  name: string;
  email?: string;
  source: string;
  community: string;
  relevanceScore: number;
  connectionPoints: string[];
  stage: OutreachStage;
  outreachDraftId?: string;
  discoveredAt: string;
  lastContactAt?: string;
  followUpAfter?: string;
  notes: string;
  profileUrl?: string;
  tags: string[];
}

export interface AddContactInput {
  name: string;
  email?: string;
  source: string;
  community: string;
  relevanceScore?: number;
  connectionPoints?: string[];
  notes?: string;
  profileUrl?: string;
  tags?: string[];
}

export interface UpdateContactInput {
  id: string;
  email?: string;
  stage?: OutreachStage;
  relevanceScore?: number;
  connectionPoints?: string[];
  outreachDraftId?: string;
  lastContactAt?: string;
  followUpAfter?: string;
  notes?: string;
  profileUrl?: string;
  tags?: string[];
}

export interface SearchFilters {
  query?: string;
  stage?: OutreachStage;
  community?: string;
  minScore?: number;
  tag?: string;
}

export interface PipelineSummary {
  total: number;
  byStage: Record<OutreachStage, number>;
  byCommunity: Record<string, number>;
  sentThisWeek: number;
  weeklyLimitRemaining: number;
  topContacts: OutreachContact[];
}

// ============================================
// CONSTANTS
// ============================================

const KAYA_HOME = process.env.HOME + "/.claude";
let STATE_FILE = KAYA_HOME + "/MEMORY/STATE/outreach-pipeline.jsonl";
const WEEKLY_OUTREACH_LIMIT = 10;
const FOLLOWUP_COOLDOWN_DAYS = 7;

// ============================================
// CORE FUNCTIONS
// ============================================

/**
 * Ensure the state file directory exists
 */
function ensureStateDir(filePath: string = STATE_FILE): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Load all contacts from the JSONL state file
 */
export function loadContacts(filePath: string = STATE_FILE): OutreachContact[] {
  ensureStateDir(filePath);

  if (!existsSync(filePath)) {
    return [];
  }

  const raw = readFileSync(filePath, "utf-8").trim();
  if (!raw) return [];

  const contacts: OutreachContact[] = [];
  const lines = raw.split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      contacts.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
      console.error(`Skipping malformed JSONL line: ${line.substring(0, 80)}...`);
    }
  }

  return contacts;
}

/**
 * Write all contacts back to the state file (full rewrite for updates)
 */
function writeContacts(contacts: OutreachContact[], filePath: string = STATE_FILE): void {
  ensureStateDir(filePath);
  const lines = contacts.map((c) => JSON.stringify(c));
  writeFileSync(filePath, lines.join("\n") + "\n");
}

/**
 * Append a single contact to the state file (efficient for additions)
 */
function appendContact(contact: OutreachContact, filePath: string = STATE_FILE): void {
  ensureStateDir(filePath);
  appendFileSync(filePath, JSON.stringify(contact) + "\n");
}

/**
 * Add a new contact to the pipeline
 */
export function addContact(input: AddContactInput, filePath: string = STATE_FILE): OutreachContact {
  const contacts = loadContacts(filePath);

  // Deduplication check: email match or name+source match
  const duplicate = contacts.find(
    (c) =>
      (input.email && c.email === input.email) ||
      (c.name.toLowerCase() === input.name.toLowerCase() &&
        c.source === input.source &&
        c.community === input.community)
  );

  if (duplicate) {
    throw new Error(
      `Duplicate contact: "${duplicate.name}" already exists (ID: ${duplicate.id}, stage: ${duplicate.stage})`
    );
  }

  const contact: OutreachContact = {
    id: randomUUID(),
    name: input.name,
    email: input.email,
    source: input.source,
    community: input.community,
    relevanceScore: input.relevanceScore ?? 0,
    connectionPoints: input.connectionPoints ?? [],
    stage: "discovered",
    discoveredAt: new Date().toISOString(),
    notes: input.notes ?? "",
    profileUrl: input.profileUrl,
    tags: input.tags ?? [],
  };

  appendContact(contact, filePath);
  return contact;
}

/**
 * Update an existing contact
 */
export function updateContact(input: UpdateContactInput, filePath: string = STATE_FILE): OutreachContact {
  const contacts = loadContacts(filePath);
  const index = contacts.findIndex((c) => c.id === input.id);

  if (index === -1) {
    throw new Error(`Contact not found: ${input.id}`);
  }

  const contact = contacts[index];

  // Apply updates
  if (input.email !== undefined) contact.email = input.email;
  if (input.stage !== undefined) contact.stage = input.stage;
  if (input.relevanceScore !== undefined) contact.relevanceScore = input.relevanceScore;
  if (input.connectionPoints !== undefined) contact.connectionPoints = input.connectionPoints;
  if (input.outreachDraftId !== undefined) contact.outreachDraftId = input.outreachDraftId;
  if (input.lastContactAt !== undefined) contact.lastContactAt = input.lastContactAt;
  if (input.followUpAfter !== undefined) contact.followUpAfter = input.followUpAfter;
  if (input.notes !== undefined) contact.notes = input.notes;
  if (input.profileUrl !== undefined) contact.profileUrl = input.profileUrl;
  if (input.tags !== undefined) contact.tags = input.tags;

  contacts[index] = contact;
  writeContacts(contacts, filePath);

  return contact;
}

/**
 * Get a single contact by ID
 */
export function getContact(id: string, filePath: string = STATE_FILE): OutreachContact | null {
  const contacts = loadContacts(filePath);
  return contacts.find((c) => c.id === id) ?? null;
}

/**
 * Search and filter contacts
 */
export function searchContacts(filters: SearchFilters, filePath: string = STATE_FILE): OutreachContact[] {
  let contacts = loadContacts(filePath);

  if (filters.query) {
    const q = filters.query.toLowerCase();
    contacts = contacts.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.notes.toLowerCase().includes(q) ||
        c.connectionPoints.some((cp) => cp.toLowerCase().includes(q)) ||
        c.tags.some((t) => t.toLowerCase().includes(q))
    );
  }

  if (filters.stage) {
    contacts = contacts.filter((c) => c.stage === filters.stage);
  }

  if (filters.community) {
    contacts = contacts.filter((c) => c.community === filters.community);
  }

  if (filters.minScore !== undefined) {
    contacts = contacts.filter((c) => c.relevanceScore >= filters.minScore!);
  }

  if (filters.tag) {
    contacts = contacts.filter((c) => c.tags.includes(filters.tag!));
  }

  // Sort by relevance score descending
  contacts.sort((a, b) => b.relevanceScore - a.relevanceScore);

  return contacts;
}

/**
 * Check how many outreach emails were sent this week
 */
export function getSentThisWeek(filePath: string = STATE_FILE): number {
  const contacts = loadContacts(filePath);
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  const weekStart = oneWeekAgo.toISOString();

  return contacts.filter(
    (c) =>
      (c.stage === "sent" || c.stage === "responded" || c.stage === "connected") &&
      c.lastContactAt &&
      c.lastContactAt >= weekStart
  ).length;
}

/**
 * Check if we can send more outreach this week
 */
export function canSendOutreach(filePath: string = STATE_FILE): { allowed: boolean; sent: number; remaining: number } {
  const sent = getSentThisWeek(filePath);
  return {
    allowed: sent < WEEKLY_OUTREACH_LIMIT,
    sent,
    remaining: Math.max(0, WEEKLY_OUTREACH_LIMIT - sent),
  };
}

/**
 * Check if follow-up is allowed for a contact (respects cool-down)
 */
export function canFollowUp(contactId: string, filePath: string = STATE_FILE): { allowed: boolean; reason: string } {
  const contact = getContact(contactId, filePath);
  if (!contact) return { allowed: false, reason: "Contact not found" };

  if (contact.stage === "opted-out") {
    return { allowed: false, reason: "Contact has opted out" };
  }

  if (!contact.lastContactAt) {
    return { allowed: true, reason: "No previous contact" };
  }

  const lastContact = new Date(contact.lastContactAt);
  const cooldownEnd = new Date(lastContact);
  cooldownEnd.setDate(cooldownEnd.getDate() + FOLLOWUP_COOLDOWN_DAYS);

  if (new Date() < cooldownEnd) {
    return {
      allowed: false,
      reason: `Cool-down active until ${cooldownEnd.toISOString().split("T")[0]}`,
    };
  }

  return { allowed: true, reason: "Cool-down expired" };
}

/**
 * Get pipeline summary statistics
 */
export function getPipelineSummary(filePath: string = STATE_FILE): PipelineSummary {
  const contacts = loadContacts(filePath);

  const stages: OutreachStage[] = [
    "discovered",
    "profiled",
    "drafted",
    "sent",
    "responded",
    "connected",
    "opted-out",
  ];

  const byStage: Record<OutreachStage, number> = {} as any;
  for (const stage of stages) {
    byStage[stage] = contacts.filter((c) => c.stage === stage).length;
  }

  const byCommunity: Record<string, number> = {};
  for (const contact of contacts) {
    byCommunity[contact.community] = (byCommunity[contact.community] || 0) + 1;
  }

  const sentThisWeek = getSentThisWeek(filePath);

  const topContacts = contacts
    .filter((c) => c.stage !== "opted-out")
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, 10);

  return {
    total: contacts.length,
    byStage,
    byCommunity,
    sentThisWeek,
    weeklyLimitRemaining: Math.max(0, WEEKLY_OUTREACH_LIMIT - sentThisWeek),
    topContacts,
  };
}

// ============================================
// CLI INTERFACE
// ============================================

function printHelp(): void {
  console.log(`
OutreachState - JSONL-backed CRM Pipeline

Usage:
  bun OutreachState.ts add --name "Name" --community "community-id" --source "source-type" [options]
  bun OutreachState.ts update --id "uuid" [--stage "profiled"] [--email "email@example.com"] [options]
  bun OutreachState.ts get --id "uuid"
  bun OutreachState.ts search [--query "search"] [--stage "discovered"] [--community "professional-ai"] [--min-score 0.5] [--tag "cofounder-potential"]
  bun OutreachState.ts list [same filters as search]
  bun OutreachState.ts summary
  bun OutreachState.ts rate-check
  bun OutreachState.ts --test

Add Options:
  --name          Contact name (required)
  --community     Community ID (required)
  --source        Source type (required): conference-speaker, meetup-organizer, blog-author, etc.
  --email         Email address
  --score         Relevance score 0.0-1.0
  --notes         Notes about the contact
  --profile-url   Profile URL
  --tags          Comma-separated tags

Update Options:
  --id            Contact UUID (required)
  --stage         Pipeline stage
  --email         Email address
  --score         Relevance score
  --notes         Notes
  --profile-url   Profile URL
  --tags          Comma-separated tags
  --draft-id      Gmail draft ID
  --last-contact  ISO timestamp of last contact
  --follow-up     ISO date for follow-up
`);
}

function parseArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length && !args[i + 1].startsWith("--")) {
      parsed[args[i].replace("--", "")] = args[i + 1];
      i++;
    } else if (args[i].startsWith("--")) {
      parsed[args[i].replace("--", "")] = "true";
    } else if (!parsed._command) {
      parsed._command = args[i];
    }
  }
  return parsed;
}

async function runSelfTest(): Promise<void> {
  const fs = await import("fs");
  const testFile = "/tmp/outreach-state-test.jsonl";

  console.log("Running OutreachState self-test...\n");

  // Clean up test file
  if (existsSync(testFile)) fs.unlinkSync(testFile);

  let passed = 0;
  let failed = 0;

  const test = (name: string, fn: () => void) => {
    try {
      fn();
      console.log(`  [PASS] ${name}`);
      passed++;
    } catch (e) {
      console.log(`  [FAIL] ${name}`);
      console.log(`         ${e instanceof Error ? e.message : e}`);
      failed++;
    }
  };

  // Test add
  test("addContact creates a contact with correct defaults", () => {
    const contact = addContact({
      name: "Test Person",
      community: "professional-ai",
      source: "conference-speaker",
      notes: "Test contact",
    }, testFile);
    if (!contact.id) throw new Error("Missing ID");
    if (contact.stage !== "discovered") throw new Error(`Wrong stage: ${contact.stage}`);
    if (contact.relevanceScore !== 0) throw new Error(`Wrong score: ${contact.relevanceScore}`);
  });

  // Test duplicate detection
  test("addContact detects duplicates by name+source+community", () => {
    try {
      addContact({
        name: "Test Person",
        community: "professional-ai",
        source: "conference-speaker",
      }, testFile);
      throw new Error("Should have thrown duplicate error");
    } catch (e) {
      if (!(e instanceof Error) || !e.message.includes("Duplicate")) {
        throw new Error(`Wrong error: ${e}`);
      }
    }
  });

  // Test load
  test("loadContacts returns all contacts", () => {
    const contacts = loadContacts(testFile);
    if (contacts.length < 1) throw new Error(`Expected at least 1 contact, got ${contacts.length}`);
  });

  // Test search
  test("searchContacts filters by community", () => {
    addContact({
      name: "Writer Person",
      community: "writing-sd",
      source: "meetup-organizer",
    }, testFile);
    const results = searchContacts({ community: "writing-sd" }, testFile);
    if (results.length !== 1) throw new Error(`Expected 1 result, got ${results.length}`);
    if (results[0].name !== "Writer Person") throw new Error("Wrong person");
  });

  // Test update
  test("updateContact modifies fields correctly", () => {
    const contacts = loadContacts(testFile);
    const contact = contacts[0];
    const updated = updateContact({
      id: contact.id,
      stage: "profiled",
      email: "test@example.com",
      relevanceScore: 0.85,
    }, testFile);
    if (updated.stage !== "profiled") throw new Error(`Wrong stage: ${updated.stage}`);
    if (updated.email !== "test@example.com") throw new Error(`Wrong email: ${updated.email}`);
    if (updated.relevanceScore !== 0.85) throw new Error(`Wrong score: ${updated.relevanceScore}`);
  });

  // Test get
  test("getContact returns contact by ID", () => {
    const contacts = loadContacts(testFile);
    const found = getContact(contacts[0].id, testFile);
    if (!found) throw new Error("Contact not found");
    if (found.name !== contacts[0].name) throw new Error("Wrong contact");
  });

  // Test rate check
  test("canSendOutreach returns correct limits", () => {
    const result = canSendOutreach(testFile);
    if (typeof result.allowed !== "boolean") throw new Error("Missing allowed flag");
    if (typeof result.sent !== "number") throw new Error("Missing sent count");
    if (typeof result.remaining !== "number") throw new Error("Missing remaining count");
  });

  // Test summary
  test("getPipelineSummary returns correct structure", () => {
    const summary = getPipelineSummary(testFile);
    if (summary.total < 2) throw new Error(`Expected at least 2 contacts, got ${summary.total}`);
    if (!summary.byStage) throw new Error("Missing byStage");
    if (!summary.byCommunity) throw new Error("Missing byCommunity");
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);

  // Cleanup test file
  if (existsSync(testFile)) fs.unlinkSync(testFile);

  process.exit(failed > 0 ? 1 : 0);
}

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  if (args.includes("--test")) {
    await runSelfTest();
    process.exit(0);
  }

  const parsed = parseArgs(args);
  const command = parsed._command;

  try {
    switch (command) {
      case "add": {
        if (!parsed.name || !parsed.community || !parsed.source) {
          console.error("Error: --name, --community, and --source are required for add");
          process.exit(1);
        }
        const contact = addContact({
          name: parsed.name,
          community: parsed.community,
          source: parsed.source,
          email: parsed.email,
          relevanceScore: parsed.score ? parseFloat(parsed.score) : undefined,
          notes: parsed.notes,
          profileUrl: parsed["profile-url"],
          tags: parsed.tags ? parsed.tags.split(",").map((t: string) => t.trim()) : undefined,
        });
        console.log(JSON.stringify(contact, null, 2));
        break;
      }

      case "update": {
        if (!parsed.id) {
          console.error("Error: --id is required for update");
          process.exit(1);
        }
        const updated = updateContact({
          id: parsed.id,
          email: parsed.email,
          stage: parsed.stage as OutreachStage,
          relevanceScore: parsed.score ? parseFloat(parsed.score) : undefined,
          notes: parsed.notes,
          profileUrl: parsed["profile-url"],
          tags: parsed.tags ? parsed.tags.split(",").map((t: string) => t.trim()) : undefined,
          outreachDraftId: parsed["draft-id"],
          lastContactAt: parsed["last-contact"],
          followUpAfter: parsed["follow-up"],
        });
        console.log(JSON.stringify(updated, null, 2));
        break;
      }

      case "get": {
        if (!parsed.id) {
          console.error("Error: --id is required for get");
          process.exit(1);
        }
        const contact = getContact(parsed.id);
        if (!contact) {
          console.error(`Contact not found: ${parsed.id}`);
          process.exit(1);
        }
        console.log(JSON.stringify(contact, null, 2));
        break;
      }

      case "search":
      case "list": {
        const results = searchContacts({
          query: parsed.query,
          stage: parsed.stage as OutreachStage,
          community: parsed.community,
          minScore: parsed["min-score"] ? parseFloat(parsed["min-score"]) : undefined,
          tag: parsed.tag,
        });
        console.log(JSON.stringify(results, null, 2));
        break;
      }

      case "summary": {
        const summary = getPipelineSummary();
        console.log(JSON.stringify(summary, null, 2));
        break;
      }

      case "rate-check": {
        const rateStatus = canSendOutreach();
        console.log(JSON.stringify(rateStatus, null, 2));
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
