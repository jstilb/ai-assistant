/**
 * LLMJudge Tests
 * TDD RED phase: Tests for rubric-based LLM grading
 */

import { describe, test, expect } from "bun:test";
import {
  type JudgeResult,
  parseJudgeResponse,
  buildJudgePrompt,
} from "../LLMJudge.ts";

describe("LLMJudge", () => {
  describe("parseJudgeResponse", () => {
    test("extracts score and reasoning from well-formatted response", () => {
      const response = `REASONING: The response correctly identifies as Kaya and uses first person voice.
SCORE: 0.9`;
      const result = parseJudgeResponse(response);
      expect(result.score).toBeCloseTo(0.9, 1);
      expect(result.reasoning).toContain("correctly identifies");
    });

    test("handles score before reasoning", () => {
      const response = `SCORE: 0.7
REASONING: Partially correct identification.`;
      const result = parseJudgeResponse(response);
      expect(result.score).toBeCloseTo(0.7, 1);
      expect(result.reasoning).toContain("Partially correct");
    });

    test("clamps score to 0-1 range", () => {
      const highResponse = `SCORE: 1.5\nREASONING: Too high`;
      const lowResponse = `SCORE: -0.5\nREASONING: Too low`;
      expect(parseJudgeResponse(highResponse).score).toBe(1);
      expect(parseJudgeResponse(lowResponse).score).toBe(0);
    });

    test("defaults to score 0 if no score found", () => {
      const response = "No structured output here, just some text.";
      const result = parseJudgeResponse(response);
      expect(result.score).toBe(0);
      expect(result.reasoning).toBeTruthy();
    });
  });

  describe("buildJudgePrompt", () => {
    test("includes prompt, response, and rubric in output", () => {
      const result = buildJudgePrompt(
        "What is my name?",
        "Your name is User.",
        "Score 1.0 if response correctly identifies user as User."
      );
      expect(result).toContain("What is my name?");
      expect(result).toContain("Your name is User.");
      expect(result).toContain("correctly identifies user as User");
    });

    test("includes scoring instructions", () => {
      const result = buildJudgePrompt("p", "r", "rubric");
      expect(result).toContain("0.0");
      expect(result).toContain("1.0");
      expect(result).toContain("SCORE:");
      expect(result).toContain("REASONING:");
    });
  });

  describe("JudgeResult structure", () => {
    test("parseJudgeResponse returns score and reasoning", () => {
      const result = parseJudgeResponse("SCORE: 0.5\nREASONING: Test");
      expect(result).toHaveProperty("score");
      expect(result).toHaveProperty("reasoning");
      expect(typeof result.score).toBe("number");
      expect(typeof result.reasoning).toBe("string");
    });
  });
});
