/**
 * CardValidation — structural check for LLM-generated flashcard JSON.
 *
 * Guards empty/malformed card writes into Anki. No content gates: content
 * judgment stays with the model; only shape and the card-count range are
 * enforced. Shared by Cooking's CuisineAnkiGenerator (4-6 cards) and LifeOS
 * Mastery's NotesToCards (2-5 cards), formerly two copies.
 */

export interface FrontBackCard {
  front: string;
  back: string;
}

/**
 * Validate `{ cards: [{ front, back }, ...] }` with minCards..maxCards
 * entries, each with a non-empty front and back. Returns trimmed cards;
 * throws a descriptive Error on any structural problem.
 */
export function validateFrontBackCards(parsed: unknown, minCards: number, maxCards: number): FrontBackCard[] {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("LLM returned non-object JSON");
  }

  const p = parsed as Record<string, unknown>;
  const cards = p.cards;

  if (!Array.isArray(cards) || cards.length < minCards || cards.length > maxCards) {
    throw new Error(`Expected ${minCards}-${maxCards} cards, got ${Array.isArray(cards) ? cards.length : "non-array"}`);
  }

  const validated: FrontBackCard[] = [];

  for (let i = 0; i < cards.length; i++) {
    const item = cards[i];
    if (typeof item !== "object" || item === null) {
      throw new Error(`Card ${i} is not an object`);
    }
    const c = item as Record<string, unknown>;

    if (typeof c.front !== "string" || c.front.trim().length === 0) {
      throw new Error(`Card ${i} has an empty or missing front`);
    }
    if (typeof c.back !== "string" || c.back.trim().length === 0) {
      throw new Error(`Card ${i} has an empty or missing back`);
    }

    validated.push({ front: c.front.trim(), back: c.back.trim() });
  }

  return validated;
}
