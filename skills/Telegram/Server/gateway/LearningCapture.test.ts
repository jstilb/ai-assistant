import { describe, test, expect } from "bun:test";
import { detectRating } from "./LearningCapture";

describe("detectRating", () => {
  test("detects explicit N/10 rating", () => {
    const result = detectRating("That was a 5/10 response");
    expect(result).not.toBeNull();
    expect(result!.rating).toBe(5);
    expect(result!.source).toBe("explicit");
    expect(result!.confidence).toBe(0.95);
  });

  test("detects explicit 'rate: N' format", () => {
    const result = detectRating("rate: 8");
    expect(result).not.toBeNull();
    expect(result!.rating).toBe(8);
    expect(result!.source).toBe("explicit");
  });

  test("detects explicit 'rating: N' format", () => {
    const result = detectRating("rating: 7");
    expect(result).not.toBeNull();
    expect(result!.rating).toBe(7);
    expect(result!.source).toBe("explicit");
  });

  test("detects explicit 'score: N' format", () => {
    const result = detectRating("score: 6");
    expect(result).not.toBeNull();
    expect(result!.rating).toBe(6);
    expect(result!.source).toBe("explicit");
  });

  test("detects strong positive sentiment 'amazing'", () => {
    const result = detectRating("That was amazing!");
    expect(result).not.toBeNull();
    expect(result!.rating).toBe(9);
    expect(result!.source).toBe("implicit");
    expect(result!.confidence).toBeGreaterThan(0.8);
  });

  test("detects positive sentiment 'great'", () => {
    const result = detectRating("Great answer, thanks!");
    expect(result).not.toBeNull();
    expect(result!.rating).toBe(7);
    expect(result!.source).toBe("implicit");
  });

  test("detects negative sentiment 'wrong'", () => {
    const result = detectRating("That's wrong, try again");
    expect(result).not.toBeNull();
    expect(result!.rating).toBe(3);
    expect(result!.source).toBe("implicit");
  });

  test("detects frustrated sentiment", () => {
    const result = detectRating("I already told you the answer");
    expect(result).not.toBeNull();
    expect(result!.rating).toBe(2);
    expect(result!.source).toBe("implicit");
  });

  test("returns null for neutral messages with no signal", () => {
    const result = detectRating("Can you tell me about the project?");
    expect(result).toBeNull();
  });

  test("returns null for empty string", () => {
    const result = detectRating("");
    expect(result).toBeNull();
  });

  test("explicit rating takes precedence over sentiment", () => {
    // "amazing" would be sentiment 9, but explicit 3/10 should win
    const result = detectRating("amazing but 3/10");
    expect(result).not.toBeNull();
    expect(result!.rating).toBe(3);
    expect(result!.source).toBe("explicit");
  });
});
