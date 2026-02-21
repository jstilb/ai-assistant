import { describe, test, expect } from "bun:test";
import { renderStatBlock, type Monster } from "../StatBlock";

// Adult Red Dragon for Foundry/Roll20 enhanced tests
const adultRedDragon: Monster = {
  name: "Adult Red Dragon",
  size: "Huge",
  type: "dragon",
  alignment: "chaotic evil",
  ac: 19,
  acType: "natural armor",
  hp: 256,
  hitDice: "19d12+133",
  speed: { walk: 40, fly: 80, climb: 40 },
  abilities: { str: 27, dex: 10, con: 25, int: 16, wis: 13, cha: 21 },
  savingThrows: { dex: 6, con: 13, wis: 7, cha: 11 },
  skills: { perception: 13, stealth: 6 },
  damageImmunities: ["fire"],
  conditionImmunities: ["frightened"],
  senses: { blindsight: 60, darkvision: 120, passivePerception: 23 },
  languages: ["Common", "Draconic"],
  cr: 17,
  xp: 18000,
  traits: [
    { name: "Legendary Resistance (3/Day)", description: "If the dragon fails a saving throw, it can choose to succeed instead." },
  ],
  actions: [
    { name: "Multiattack", description: "The dragon makes three attacks: one with its bite and two with its claws." },
    { name: "Bite", description: "Melee Weapon Attack: +14 to hit, reach 10 ft., one target. Hit: 19 (2d10 + 8) piercing damage plus 7 (2d6) fire damage." },
    { name: "Claw", description: "Melee Weapon Attack: +14 to hit, reach 5 ft., one target. Hit: 15 (2d6 + 8) slashing damage." },
    { name: "Fire Breath (Recharge 5-6)", description: "The dragon exhales fire in a 60-foot cone. DC 21 Dex save, 63 (18d6) fire damage." },
  ],
  legendaryActions: [
    { name: "Detect", description: "The dragon makes a Wisdom (Perception) check." },
    { name: "Tail Attack", description: "The dragon makes a tail attack." },
  ],
};

// Goblin for size token tests
const goblin: Monster = {
  name: "Goblin",
  size: "Small",
  type: "humanoid",
  subtype: "goblinoid",
  alignment: "neutral evil",
  ac: 15,
  acType: "leather armor, shield",
  hp: 7,
  hitDice: "2d6",
  speed: { walk: 30 },
  abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
  skills: { stealth: 6 },
  damageResistances: [],
  damageImmunities: [],
  conditionImmunities: [],
  senses: { darkvision: 60, passivePerception: 9 },
  languages: ["Common", "Goblin"],
  cr: 0.25,
  xp: 50,
  traits: [
    { name: "Nimble Escape", description: "The goblin can take the Disengage or Hide action as a bonus action." },
  ],
  actions: [
    { name: "Scimitar", description: "Melee Weapon Attack: +4 to hit, reach 5 ft., one target. Hit: 5 (1d6 + 2) slashing damage." },
    { name: "Shortbow", description: "Ranged Weapon Attack: +4 to hit, range 80/320 ft., one target. Hit: 5 (1d6 + 2) piercing damage." },
  ],
};

// Gargantuan creature for token size test
const tarrasque: Monster = {
  name: "Tarrasque",
  size: "Gargantuan",
  type: "monstrosity",
  alignment: "unaligned",
  ac: 25,
  acType: "natural armor",
  hp: 676,
  hitDice: "33d20+330",
  speed: { walk: 40 },
  abilities: { str: 30, dex: 11, con: 30, int: 3, wis: 11, cha: 11 },
  cr: 30,
  xp: 155000,
  actions: [
    { name: "Bite", description: "Melee Weapon Attack: +19 to hit, reach 10 ft., one target. Hit: 36 (4d12+10) piercing damage." },
  ],
};

describe("StatBlock Enhanced VTT Export", () => {
  // ============================================
  // Enhanced Foundry VTT Export
  // ============================================
  describe("foundry-vtt enhanced export", () => {
    test("includes items array with structured actions", () => {
      const result = renderStatBlock(adultRedDragon, "foundry-vtt");
      const parsed = JSON.parse(result);
      expect(parsed).toHaveProperty("items");
      expect(Array.isArray(parsed.items)).toBe(true);
      expect(parsed.items.length).toBeGreaterThan(0);
    });

    test("action items have proper Foundry structure", () => {
      const result = renderStatBlock(adultRedDragon, "foundry-vtt");
      const parsed = JSON.parse(result);
      const bite = parsed.items.find((i: any) => i.name === "Bite");
      expect(bite).toBeDefined();
      expect(bite.type).toBeDefined();
      expect(bite).toHaveProperty("system");
    });

    test("includes prototypeToken for Huge creature", () => {
      const result = renderStatBlock(adultRedDragon, "foundry-vtt");
      const parsed = JSON.parse(result);
      expect(parsed).toHaveProperty("prototypeToken");
      expect(parsed.prototypeToken.width).toBe(3); // Huge = 3
      expect(parsed.prototypeToken.height).toBe(3);
    });

    test("Small/Medium creatures get 1x1 token", () => {
      const result = renderStatBlock(goblin, "foundry-vtt");
      const parsed = JSON.parse(result);
      expect(parsed.prototypeToken.width).toBe(1);
      expect(parsed.prototypeToken.height).toBe(1);
    });

    test("Gargantuan creatures get 4x4 token", () => {
      const result = renderStatBlock(tarrasque, "foundry-vtt");
      const parsed = JSON.parse(result);
      expect(parsed.prototypeToken.width).toBe(4);
      expect(parsed.prototypeToken.height).toBe(4);
    });

    test("includes img path reference field", () => {
      const result = renderStatBlock(adultRedDragon, "foundry-vtt");
      const parsed = JSON.parse(result);
      expect(parsed).toHaveProperty("img");
    });

    test("includes system.details with CR, type, size, alignment, source", () => {
      const result = renderStatBlock(adultRedDragon, "foundry-vtt");
      const parsed = JSON.parse(result);
      expect(parsed.system.details.cr).toBe(17);
      expect(parsed.system.details.type.value).toBe("dragon");
      expect(parsed.system.details.alignment).toBe("chaotic evil");
      expect(parsed.system.details.source).toBeDefined();
    });

    test("includes system.traits with damage resistances and immunities", () => {
      const result = renderStatBlock(adultRedDragon, "foundry-vtt");
      const parsed = JSON.parse(result);
      expect(parsed.system.traits).toHaveProperty("di"); // damage immunities
      expect(parsed.system.traits).toHaveProperty("dr"); // damage resistances
      expect(parsed.system.traits).toHaveProperty("ci"); // condition immunities
      expect(parsed.system.traits.di.value).toContain("fire");
    });

    test("includes prototypeToken.texture.src field", () => {
      const result = renderStatBlock(adultRedDragon, "foundry-vtt");
      const parsed = JSON.parse(result);
      expect(parsed.prototypeToken).toHaveProperty("texture");
      expect(parsed.prototypeToken.texture).toHaveProperty("src");
    });
  });

  // ============================================
  // Enhanced Roll20 Export
  // ============================================
  describe("roll20 enhanced export", () => {
    test("includes NPC action attributes", () => {
      const result = renderStatBlock(adultRedDragon, "roll20");
      const parsed = JSON.parse(result);
      const findAttr = (name: string) =>
        parsed.attribs.find((a: any) => a.name === name);
      // Roll20 uses repeating_ attributes for NPC actions
      const hasNpcAction = parsed.attribs.some((a: any) =>
        a.name.startsWith("repeating_npcaction")
      );
      expect(hasNpcAction).toBe(true);
    });

    test("includes damage resistance/immunity attributes", () => {
      const result = renderStatBlock(adultRedDragon, "roll20");
      const parsed = JSON.parse(result);
      const findAttr = (name: string) =>
        parsed.attribs.find((a: any) => a.name === name);
      expect(findAttr("npc_immunities")).toBeDefined();
      expect(findAttr("npc_immunities")?.current).toContain("fire");
    });

    test("includes condition immunity attributes", () => {
      const result = renderStatBlock(adultRedDragon, "roll20");
      const parsed = JSON.parse(result);
      const findAttr = (name: string) =>
        parsed.attribs.find((a: any) => a.name === name);
      expect(findAttr("npc_condition_immunities")).toBeDefined();
    });
  });
});
