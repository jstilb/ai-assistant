/**
 * Test fixtures for GoalConnector.parseGoals()
 *
 * Derived from real TELOS GOALS.md structure, anonymized.
 * Each fixture represents a different test scenario.
 */

/** Valid multi-goal markdown with WIG and regular sections */
export const VALID_GOALS_MD = `# GOALS

## WIGs (Wildly Important Goals)

### G0: Reduce daily screen time
**Status:** Active
**Supports:** M6 Self
**Target:** Under 2 hours
**Metric:** Screen Time App
**Current:** 3.5 hours average

### G1: Strengthen core friendships
**Status:** Active
**Supports:** M4 Friend
**Target:** Monthly contact with top 10
**Metric:** Contact log

## M5: Professional

### G25: Launch beta application
**Status:** In Progress
**Supports:** M5 Professional
**Target:** 100 beta users
**Metric:** User count
**Current:** 12 users
**Lead Measures:** Weekly feature releases

### G28: Master AI tooling
**Status:** Active
**Supports:** M5 Professional
**Target:** Daily AI-assisted workflow
**Metric:** Tasks completed with AI

## M2: Creative

### G13: Complete first novel draft
**Status:** In Progress
**Supports:** M2 Creative
**Target:** 80,000 words
**Metric:** Word count
**Current:** 45,000 words
`;

/** Empty content -- no goals to parse */
export const EMPTY_GOALS_MD = `# GOALS

No goals defined yet.
`;

/** Malformed content with missing fields */
export const MALFORMED_GOALS_MD = `# GOALS

## Some Section

### G99: Goal with no metadata

### NotAGoal: This should be skipped

### G100: Partial goal
**Status:** Active

Some random text that is not a field.

### G101: Another partial
**Supports:** M0 Adventure
`;

/** Content with special characters in titles and values */
export const SPECIAL_CHARS_GOALS_MD = `# GOALS

## Special Goals

### G50: Use "quotes" & ampersands <tags>
**Status:** Active -- with dashes
**Supports:** M6 Self (primary)
**Target:** 100% compliance
**Metric:** Pass/fail ratio

### G51: Goals with unicode: cafe\u0301 & na\u00EFve
**Status:** Pending
**Supports:** M0 Adventurer
`;

/** Single goal for minimal parsing check */
export const SINGLE_GOAL_MD = `# GOALS

## WIGs (Wildly Important Goals)

### G7: Join local organization
**Status:** Active
**Supports:** M1 Community Member
**Target:** Weekly attendance
`;

/** Expected parsed output for VALID_GOALS_MD */
export const EXPECTED_VALID_GOALS = [
  {
    id: "G0",
    title: "Reduce daily screen time",
    status: "Active",
    supports: "M6 Self",
    target: "Under 2 hours",
    metric: "Screen Time App",
    current: "3.5 hours average",
    isWIG: true,
    section: "WIGs (Wildly Important Goals)",
  },
  {
    id: "G1",
    title: "Strengthen core friendships",
    status: "Active",
    supports: "M4 Friend",
    target: "Monthly contact with top 10",
    metric: "Contact log",
    isWIG: true,
    section: "WIGs (Wildly Important Goals)",
  },
  {
    id: "G25",
    title: "Launch beta application",
    status: "In Progress",
    supports: "M5 Professional",
    target: "100 beta users",
    metric: "User count",
    current: "12 users",
    leadMeasures: "Weekly feature releases",
    isWIG: false,
    section: "M5: Professional",
  },
  {
    id: "G28",
    title: "Master AI tooling",
    status: "Active",
    supports: "M5 Professional",
    target: "Daily AI-assisted workflow",
    metric: "Tasks completed with AI",
    isWIG: false,
    section: "M5: Professional",
  },
  {
    id: "G13",
    title: "Complete first novel draft",
    status: "In Progress",
    supports: "M2 Creative",
    target: "80,000 words",
    metric: "Word count",
    current: "45,000 words",
    isWIG: false,
    section: "M2: Creative",
  },
];
