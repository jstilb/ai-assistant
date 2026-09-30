import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  slugify,
  inferDevice,
  buildNote,
  resolveNotePath,
  uniquePath,
  vaultCategories,
  discoverPending,
  loadLedger,
  saveLedger,
  hashFile,
  buildOrganizePrompt,
  type Organized,
} from "./VoiceNotesProcessor.ts";
import { defaultConfig } from "./config.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vn-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("slugify", () => {
  it("lowercases, hyphenates, trims", () => {
    expect(slugify("My Great Idea!")).toBe("my-great-idea");
    expect(slugify("  spaces  ")).toBe("spaces");
  });
  it("falls back for empty input", () => {
    expect(slugify("!!!")).toBe("voice-note");
    expect(slugify("")).toBe("voice-note");
  });
});

describe("inferDevice", () => {
  it("detects iCloud Drive as mobile", () => {
    expect(inferDevice("/Users/x/Library/Mobile Documents/com~apple~CloudDocs/VoiceNotesInbox")).toBe("mobile");
  });
  it("defaults to desktop for a local folder", () => {
    expect(inferDevice("/Users/x/VoiceNotesInbox")).toBe("desktop");
  });
  it("marks Apple Voice Memos as unknown", () => {
    expect(inferDevice("/Users/x/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings")).toBe("unknown");
  });
});

describe("buildNote", () => {
  const org: Organized = {
    title: "Surf Trip Plan",
    category: "Travel",
    summary: "Planning a surf trip to Mexico.",
    tags: ["surf", "#travel"],
    cleaned: "We should book flights to Sayulita.",
    actionItems: ["Book flights", "Find a board"],
    links: ["Mexico", "[[Surf Spots]]"],
  };
  const note = buildNote(org, "uh we should like book flights to sayulita", {
    title: org.title,
    createdISO: "2026-06-23T10:00:00.000Z",
    audioName: "memo.m4a",
    durationSec: 42,
    device: "mobile",
    model: "large-v3",
  });

  it("emits frontmatter with voice-note source and dedup'd tags", () => {
    expect(note).toContain("source: voice-note");
    expect(note).toContain("device: mobile");
    expect(note).toContain("duration_sec: 42");
    expect(note).toContain("transcription_model: large-v3");
    // tags deduped, leading # stripped, voice-note prepended
    expect(note).toMatch(/tags: \[voice-note, surf, travel\]/);
  });
  it("includes summary callout, action items, related links and raw transcript", () => {
    expect(note).toContain("> [!summary] Planning a surf trip to Mexico.");
    expect(note).toContain("- [ ] Book flights");
    expect(note).toContain("[[Mexico]]");
    expect(note).toContain("[[Surf Spots]]");
    expect(note).toContain("## Raw Transcript");
    expect(note).toContain("> uh we should like book flights to sayulita");
  });
});

describe("resolveNotePath", () => {
  const cfg = defaultConfig();
  it("uses a valid category and date-slug filename", () => {
    const p = resolveNotePath(cfg, ["Travel", "Writing"], "Travel", "Surf Trip", "2026-06-23T10:00:00.000Z");
    expect(p).toContain(join("Travel", "Voice Notes", "2026-06-23-surf-trip.md"));
  });
  it("falls back to defaultCategory for an unknown category", () => {
    const p = resolveNotePath(cfg, ["Travel"], "Nonexistent", "Idea", "2026-06-23T10:00:00.000Z");
    expect(p).toContain(join("Voice Notes", "Voice Notes", "2026-06-23-idea.md"));
  });
});

describe("uniquePath", () => {
  it("returns the path when free", () => {
    const p = join(tmp, "a.md");
    expect(uniquePath(p)).toBe(p);
  });
  it("appends a suffix on collision", () => {
    const p = join(tmp, "a.md");
    writeFileSync(p, "x");
    expect(uniquePath(p)).toBe(join(tmp, "a-2.md"));
  });
});

describe("vaultCategories", () => {
  it("lists top-level dirs, skipping dot/underscore", () => {
    mkdirSync(join(tmp, "Travel"));
    mkdirSync(join(tmp, "Writing"));
    mkdirSync(join(tmp, ".obsidian"));
    mkdirSync(join(tmp, "_templates"));
    writeFileSync(join(tmp, "note.md"), "x");
    expect(vaultCategories(tmp)).toEqual(["Travel", "Writing"]);
  });
  it("returns [] for a missing vault", () => {
    expect(vaultCategories(join(tmp, "nope"))).toEqual([]);
  });
});

describe("ledger + discovery", () => {
  it("round-trips the ledger", () => {
    const lpath = join(tmp, "ledger.json");
    const led = loadLedger(lpath);
    led.processed["abc"] = {
      hash: "abc",
      originalName: "m.m4a",
      notePath: "/x.md",
      processedAt: "2026-06-23T00:00:00Z",
      device: "mobile",
    };
    saveLedger(lpath, led);
    expect(loadLedger(lpath).processed["abc"].notePath).toBe("/x.md");
  });

  it("discovers supported audio and skips already-processed hashes", () => {
    const src = join(tmp, "inbox");
    mkdirSync(src);
    const audio = join(src, "memo.m4a");
    writeFileSync(audio, "FAKEAUDIO");
    writeFileSync(join(src, "notes.txt"), "ignore me"); // unsupported ext
    writeFileSync(join(src, ".hidden.m4a"), "hidden"); // dotfile

    const cfg = { ...defaultConfig(), sources: [src] };
    let pending = discoverPending(cfg, { processed: {} });
    expect(pending.map((p) => p.path)).toEqual([audio]);

    // After recording its hash, it is no longer pending.
    const led = { processed: { [hashFile(audio)]: {
      hash: hashFile(audio), originalName: "memo.m4a", notePath: "/x.md",
      processedAt: "now", device: "desktop",
    } } };
    pending = discoverPending(cfg, led);
    expect(pending).toEqual([]);
  });
});

describe("buildOrganizePrompt", () => {
  it("lists the allowed categories", () => {
    const p = buildOrganizePrompt(["Travel", "Writing"]);
    expect(p).toContain("- Travel");
    expect(p).toContain("- Writing");
    expect(p).toContain("STRICT JSON");
  });
});
