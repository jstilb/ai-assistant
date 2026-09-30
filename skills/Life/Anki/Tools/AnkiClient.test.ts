/**
 * Tests for ISC 601: Anki AnkiClient — prerequisite validation with `which apy` check
 */

import { describe, it, expect } from "bun:test";
import { AnkiClient, parseListNotesOutput } from "./AnkiClient";

describe("AnkiClient — ISC 601: prerequisite validation", () => {
  describe("apy not installed scenario (explicit nonexistent binary)", () => {
    it("validatePrerequisites throws when binary path does not exist", async () => {
      const client = new AnkiClient({ apyBin: "/nonexistent/path/to/apy" });
      let threw = false;
      try {
        await client.validatePrerequisites();
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });

    it("error message contains 'apy not installed' when binary not found", async () => {
      const client = new AnkiClient({ apyBin: "/nonexistent/path/to/apy" });
      let errorMessage = "";
      try {
        await client.validatePrerequisites();
      } catch (err) {
        errorMessage = String(err);
      }
      expect(errorMessage).toMatch(/apy not installed/i);
    });

    it("error message contains 'pip install apy' hint", async () => {
      const client = new AnkiClient({ apyBin: "/nonexistent/path/to/apy" });
      let errorMessage = "";
      try {
        await client.validatePrerequisites();
      } catch (err) {
        errorMessage = String(err);
      }
      expect(errorMessage).toContain("pip install apy");
    });

    it("listDecks() propagates prerequisite error when apy not found", async () => {
      const client = new AnkiClient({ apyBin: "/nonexistent/path/to/apy" });
      let threw = false;
      let errorMessage = "";
      try {
        await client.listDecks();
      } catch (err) {
        threw = true;
        errorMessage = String(err);
      }
      expect(threw).toBe(true);
      expect(errorMessage).toMatch(/apy/i);
    });

    it("addCard() returns { success: false } when apy not found", async () => {
      const client = new AnkiClient({ apyBin: "/nonexistent/path/to/apy" });
      let result: { success: boolean } | null = null;
      let threw = false;
      try {
        result = await client.addCard("TestDeck", "Front", "Back");
      } catch {
        threw = true;
      }
      if (!threw) {
        expect(result).not.toBeNull();
        expect(result!.success).toBe(false);
      }
    });
  });

  describe("PrerequisiteResult type contract", () => {
    it("validatePrerequisites always throws or returns typed result with prerequisitesMet boolean", async () => {
      const client = new AnkiClient({ apyBin: "/nonexistent/path/to/apy" });
      let result: { prerequisitesMet: boolean } | null = null;
      try {
        result = await client.validatePrerequisites();
        expect(typeof result.prerequisitesMet).toBe("boolean");
      } catch (err) {
        expect(String(err)).toMatch(/apy/i);
      }
    });
  });

  describe("AddCardResult type contract", () => {
    it("addCard result has success boolean field", async () => {
      const client = new AnkiClient({ apyBin: "/nonexistent/path/to/apy" });
      try {
        const result = await client.addCard("TestDeck", "Front", "Back");
        expect(typeof result.success).toBe("boolean");
      } catch (err) {
        expect(String(err)).toMatch(/apy/i);
      }
    });
  });

  describe("DeckInfo type contract", () => {
    it("listDecks throws or returns typed array", async () => {
      const client = new AnkiClient({ apyBin: "/nonexistent/path/to/apy" });
      try {
        const decks = await client.listDecks();
        expect(Array.isArray(decks)).toBe(true);
      } catch (err) {
        expect(String(err)).toMatch(/apy/i);
      }
    });
  });

  describe("listNotes() propagates prerequisite error when apy not found", () => {
    it("throws when binary path does not exist", async () => {
      const client = new AnkiClient({ apyBin: "/nonexistent/path/to/apy" });
      let threw = false;
      let errorMessage = "";
      try {
        await client.listNotes("tag:kaya-auto");
      } catch (err) {
        threw = true;
        errorMessage = String(err);
      }
      expect(threw).toBe(true);
      expect(errorMessage).toMatch(/apy/i);
    });
  });

  describe("parseListNotesOutput — pure parser, no apy call", () => {
    it("parses a single note block", () => {
      const output = [
        "# Note (nid: 1784221593839)",
        "",
        "## Front",
        "What is the capital of France?",
        "",
        "## Back",
        "Paris",
        "",
      ].join("\n");
      const notes = parseListNotesOutput(output);
      expect(notes).toEqual([{ nid: "1784221593839", front: "What is the capital of France?" }]);
    });

    it("parses multiple note blocks", () => {
      const output = [
        "# Note (nid: 111)",
        "",
        "## Front",
        "Front one",
        "",
        "## Back",
        "Back one",
        "",
        "# Note (nid: 222)",
        "",
        "## Front",
        "Front two",
        "",
        "## Back",
        "Back two",
        "",
      ].join("\n");
      const notes = parseListNotesOutput(output);
      expect(notes).toEqual([
        { nid: "111", front: "Front one" },
        { nid: "222", front: "Front two" },
      ]);
    });

    it("handles the '## Front (markdown)' heading variant", () => {
      const output = [
        "# Note (nid: 333)",
        "",
        "## Front (markdown)",
        "**Bold** question?",
        "",
        "## Back",
        "An answer",
        "",
      ].join("\n");
      const notes = parseListNotesOutput(output);
      expect(notes).toEqual([{ nid: "333", front: "**Bold** question?" }]);
    });

    it("trims a multi-line front section to its first non-empty content", () => {
      const output = [
        "# Note (nid: 444)",
        "",
        "## Front",
        "",
        "  Line one of the front  ",
        "Line two",
        "",
        "## Back",
        "Back text",
        "",
      ].join("\n");
      const notes = parseListNotesOutput(output);
      expect(notes.length).toBe(1);
      expect(notes[0].nid).toBe("444");
      expect(notes[0].front).toBe("Line one of the front  \nLine two");
    });

    it("returns an empty array for empty or note-less output", () => {
      expect(parseListNotesOutput("")).toEqual([]);
      expect(parseListNotesOutput("No matching notes.\n")).toEqual([]);
    });

    it("skips a note whose Front section never appears", () => {
      const output = [
        "# Note (nid: 555)",
        "",
        "## Back",
        "Back only, no front heading",
        "",
      ].join("\n");
      expect(parseListNotesOutput(output)).toEqual([]);
    });
  });
});
