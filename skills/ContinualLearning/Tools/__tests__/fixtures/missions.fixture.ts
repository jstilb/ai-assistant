/**
 * Test fixtures for GoalConnector.parseMissions()
 *
 * Derived from real TELOS MISSIONS.md structure, anonymized.
 */

/** Valid multi-mission markdown with goal mapping table */
export const VALID_MISSIONS_MD = `# MISSIONS

## Overview

The 7 life missions define areas of focus.

### M0: Adventurer
**Definition:** Explore the world through travel and new experiences
**Focus:** International and domestic travel
**2026 Theme:** Year of Discovery

### M1: Community Member
**Definition:** Engage with local community and civic life
**Focus:** Activism and local groups
**2026 Theme:** Deep Roots

### M5: Professional
**Definition:** Build career and business ventures
**Focus:** AI and startup development
**2026 Theme:** Ship It

## Mission \u2192 Goal Mapping

| Mission | Goals |
|---------|-------|
| M0 | G3, G4, G5, G6 |
| M1 | G7, G8, G9, G10, G11, G12 |
| M5 | G25, G26, G27, G28 |

---
`;

/** Empty missions content */
export const EMPTY_MISSIONS_MD = `# MISSIONS

No missions defined.
`;

/** Malformed missions content with missing fields */
export const MALFORMED_MISSIONS_MD = `# MISSIONS

### M99: Mission with no fields

### NotAMission: Should be skipped

### M100: Partial mission
**Definition:** Only has definition

Random text in the middle.

### M101: Another partial
**Focus:** Only has focus
`;

/** Single mission for minimal parsing */
export const SINGLE_MISSION_MD = `# MISSIONS

### M6: Self
**Definition:** Personal growth, health, and wellness
**Focus:** Habit building and injury recovery
**2026 Theme:** Rebuild

---
`;

/** Expected parsed output for VALID_MISSIONS_MD */
export const EXPECTED_VALID_MISSIONS = [
  {
    id: "M0",
    name: "Adventurer",
    definition: "Explore the world through travel and new experiences",
    focus: "International and domestic travel",
    theme2026: "Year of Discovery",
    goalIds: ["G3", "G4", "G5", "G6"],
  },
  {
    id: "M1",
    name: "Community Member",
    definition: "Engage with local community and civic life",
    focus: "Activism and local groups",
    theme2026: "Deep Roots",
    goalIds: ["G7", "G8", "G9", "G10", "G11", "G12"],
  },
  {
    id: "M5",
    name: "Professional",
    definition: "Build career and business ventures",
    focus: "AI and startup development",
    theme2026: "Ship It",
    goalIds: ["G25", "G26", "G27", "G28"],
  },
];
