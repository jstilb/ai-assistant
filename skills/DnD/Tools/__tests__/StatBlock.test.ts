import { describe, test, expect } from "bun:test";
import { renderStatBlock, type Monster, type StatBlockFormat } from "../StatBlock";

// Sample monster for testing - Adult Red Dragon from SRD
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
  abilities: {
    str: 27,
    dex: 10,
    con: 25,
    int: 16,
    wis: 13,
    cha: 21,
  },
  savingThrows: { dex: 6, con: 13, wis: 7, cha: 11 },
  skills: { perception: 13, stealth: 6 },
  damageImmunities: ["fire"],
  senses: { blindsight: 60, darkvision: 120, passivePerception: 23 },
  languages: ["Common", "Draconic"],
  cr: 17,
  xp: 18000,
  traits: [
    {
      name: "Legendary Resistance (3/Day)",
      description: "If the dragon fails a saving throw, it can choose to succeed instead.",
    },
  ],
  actions: [
    {
      name: "Multiattack",
      description:
        "The dragon can use its Frightful Presence. It then makes three attacks: one with its bite and two with its claws.",
    },
    {
      name: "Bite",
      description:
        "Melee Weapon Attack: +14 to hit, reach 10 ft., one target. Hit: 19 (2d10 + 8) piercing damage plus 7 (2d6) fire damage.",
    },
    {
      name: "Claw",
      description:
        "Melee Weapon Attack: +14 to hit, reach 5 ft., one target. Hit: 15 (2d6 + 8) slashing damage.",
    },
    {
      name: "Tail",
      description:
        "Melee Weapon Attack: +14 to hit, reach 15 ft., one target. Hit: 17 (2d8 + 8) bludgeoning damage.",
    },
    {
      name: "Frightful Presence",
      description:
        "Each creature of the dragon's choice that is within 120 feet of the dragon and aware of it must succeed on a DC 19 Wisdom saving throw or become frightened for 1 minute.",
    },
    {
      name: "Fire Breath (Recharge 5-6)",
      description:
        "The dragon exhales fire in a 60-foot cone. Each creature in that area must make a DC 21 Dexterity saving throw, taking 63 (18d6) fire damage on a failed save, or half as much damage on a successful one.",
    },
  ],
  legendaryActions: [
    {
      name: "Detect",
      description: "The dragon makes a Wisdom (Perception) check.",
    },
    {
      name: "Tail Attack",
      description: "The dragon makes a tail attack.",
    },
    {
      name: "Wing Attack (Costs 2 Actions)",
      description:
        "The dragon beats its wings. Each creature within 10 feet of the dragon must succeed on a DC 22 Dexterity saving throw or take 15 (2d6 + 8) bludgeoning damage and be knocked prone. The dragon can then fly up to half its flying speed.",
    },
  ],
};

// Simple monster for quick tests
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
  abilities: {
    str: 8,
    dex: 14,
    con: 10,
    int: 10,
    wis: 8,
    cha: 8,
  },
  skills: { stealth: 6 },
  senses: { darkvision: 60, passivePerception: 9 },
  languages: ["Common", "Goblin"],
  cr: 0.25,
  xp: 50,
  traits: [
    {
      name: "Nimble Escape",
      description:
        "The goblin can take the Disengage or Hide action as a bonus action on each of its turns.",
    },
  ],
  actions: [
    {
      name: "Scimitar",
      description:
        "Melee Weapon Attack: +4 to hit, reach 5 ft., one target. Hit: 5 (1d6 + 2) slashing damage.",
    },
    {
      name: "Shortbow",
      description:
        "Ranged Weapon Attack: +4 to hit, range 80/320 ft., one target. Hit: 5 (1d6 + 2) piercing damage.",
    },
  ],
};

describe("StatBlock", () => {
  describe("markdown format", () => {
    test("renders a complete markdown stat block", () => {
      const result = renderStatBlock(adultRedDragon, "markdown");
      expect(typeof result).toBe("string");
      expect(result).toContain("# Adult Red Dragon");
      expect(result).toContain("Huge dragon");
      expect(result).toContain("chaotic evil");
      expect(result).toContain("19");
      expect(result).toContain("256");
      expect(result).toContain("Multiattack");
      expect(result).toContain("Fire Breath");
    });

    test("includes ability scores", () => {
      const result = renderStatBlock(adultRedDragon, "markdown");
      expect(result).toContain("27");  // STR
      expect(result).toContain("10");  // DEX
      expect(result).toContain("25");  // CON
    });

    test("includes legendary actions if present", () => {
      const result = renderStatBlock(adultRedDragon, "markdown");
      expect(result).toContain("Legendary Actions");
      expect(result).toContain("Detect");
      expect(result).toContain("Wing Attack");
    });

    test("omits legendary actions section if not present", () => {
      const result = renderStatBlock(goblin, "markdown");
      expect(result).not.toContain("Legendary Actions");
    });

    test("renders fractional CR correctly", () => {
      const result = renderStatBlock(goblin, "markdown");
      expect(result).toContain("1/4");
    });
  });

  describe("text format", () => {
    test("renders a plain text stat block", () => {
      const result = renderStatBlock(goblin, "text");
      expect(typeof result).toBe("string");
      expect(result).toContain("Goblin");
      expect(result).toContain("Small humanoid");
      expect(result).not.toContain("#"); // No markdown headers
    });

    test("includes all key sections", () => {
      const result = renderStatBlock(adultRedDragon, "text");
      expect(result).toContain("Armor Class");
      expect(result).toContain("Hit Points");
      expect(result).toContain("Speed");
      expect(result).toContain("Actions");
    });
  });

  describe("json format", () => {
    test("returns valid JSON string of monster data", () => {
      const result = renderStatBlock(goblin, "json");
      const parsed = JSON.parse(result);
      expect(parsed.name).toBe("Goblin");
      expect(parsed.hp).toBe(7);
      expect(parsed.cr).toBe(0.25);
    });

    test("preserves all monster fields in JSON", () => {
      const result = renderStatBlock(adultRedDragon, "json");
      const parsed = JSON.parse(result);
      expect(parsed.legendaryActions).toBeDefined();
      expect(parsed.legendaryActions.length).toBe(3);
      expect(parsed.actions.length).toBe(6);
    });
  });

  describe("foundry-vtt format", () => {
    test("returns valid Foundry VTT actor JSON", () => {
      const result = renderStatBlock(adultRedDragon, "foundry-vtt");
      const parsed = JSON.parse(result);
      expect(parsed.name).toBe("Adult Red Dragon");
      expect(parsed.type).toBe("npc");
      expect(parsed).toHaveProperty("system");
      expect(parsed.system).toHaveProperty("attributes");
      expect(parsed.system).toHaveProperty("abilities");
    });

    test("maps abilities to Foundry format", () => {
      const result = renderStatBlock(adultRedDragon, "foundry-vtt");
      const parsed = JSON.parse(result);
      expect(parsed.system.abilities.str.value).toBe(27);
      expect(parsed.system.abilities.dex.value).toBe(10);
      expect(parsed.system.abilities.con.value).toBe(25);
    });

    test("includes HP, AC, and movement in Foundry format", () => {
      const result = renderStatBlock(goblin, "foundry-vtt");
      const parsed = JSON.parse(result);
      expect(parsed.system.attributes.hp.value).toBe(7);
      expect(parsed.system.attributes.ac.flat).toBe(15);
      expect(parsed.system.attributes.movement.walk).toBe(30);
    });

    test("includes CR and XP in Foundry format", () => {
      const result = renderStatBlock(adultRedDragon, "foundry-vtt");
      const parsed = JSON.parse(result);
      expect(parsed.system.details.cr).toBe(17);
      expect(parsed.system.details.xp.value).toBe(18000);
    });
  });

  describe("roll20 format", () => {
    test("returns valid Roll20 NPC JSON", () => {
      const result = renderStatBlock(goblin, "roll20");
      const parsed = JSON.parse(result);
      expect(parsed.name).toBe("Goblin");
      expect(parsed).toHaveProperty("bio");
      expect(parsed).toHaveProperty("attribs");
    });

    test("includes key attributes for Roll20", () => {
      const result = renderStatBlock(adultRedDragon, "roll20");
      const parsed = JSON.parse(result);
      // Roll20 uses attribs array with name/current pairs
      const findAttr = (name: string) =>
        parsed.attribs.find((a: any) => a.name === name);
      expect(findAttr("npc_name")?.current).toBe("Adult Red Dragon");
      expect(findAttr("hp")?.current).toBe("256");
      expect(findAttr("npc_ac")?.current).toBe("19");
    });
  });

  describe("edge cases", () => {
    test("handles monster with minimal fields", () => {
      const minimal: Monster = {
        name: "Test Creature",
        size: "Medium",
        type: "beast",
        alignment: "unaligned",
        ac: 10,
        hp: 4,
        hitDice: "1d8",
        speed: { walk: 30 },
        abilities: { str: 10, dex: 10, con: 10, int: 2, wis: 10, cha: 4 },
        cr: 0,
        xp: 10,
        actions: [],
      };
      // Should not throw for any format
      expect(() => renderStatBlock(minimal, "markdown")).not.toThrow();
      expect(() => renderStatBlock(minimal, "text")).not.toThrow();
      expect(() => renderStatBlock(minimal, "json")).not.toThrow();
      expect(() => renderStatBlock(minimal, "foundry-vtt")).not.toThrow();
      expect(() => renderStatBlock(minimal, "roll20")).not.toThrow();
    });
  });
});
