# TELOS -- Personal Goal System

> This directory contains your personal goals, missions, beliefs, and
> strategies. Entirely excluded from the public repository. This README
> explains the framework.

## Purpose

TELOS is Kaya's goal-tracking system. It provides structured storage for your life goals, current missions, challenges, and strategies. Kaya references these files to align its assistance with your broader objectives.

## Structure

```
TELOS/
  MISSIONS.md      # Active missions (3-6 month objectives)
  GOALS.md         # Long-term goals (1-5 year aspirations)
  CHALLENGES.md    # Current obstacles and blockers
  STATUS.md        # Weekly status updates
  STRATEGIES.md    # Approaches and tactics
  BELIEFS.md       # Core beliefs and values
```

## Example MISSIONS.md

```markdown
# Active Missions

## Mission 1: Launch SaaS Product
- **Timeline:** Q1 2026
- **Status:** In Progress (60%)
- **Key Results:**
  - [ ] MVP deployed to production
  - [x] Core API complete
  - [ ] 10 beta users onboarded

## Mission 2: Improve Physical Health
- **Timeline:** Ongoing
- **Status:** Active
- **Key Results:**
  - [x] Exercise 4x per week
  - [ ] Reduce caffeine to 2 cups/day
```

## How Kaya Uses TELOS

1. TELOS files are listed in `settings.json` under `contextFiles`
2. On session start, the ContextRouter loads relevant TELOS content
3. Kaya can reference your goals when making suggestions
4. The DailyBriefing skill includes TELOS status in morning briefings

## Setup

Create the files listed above with your personal goals. The Telos skill (`skills/Telos/`) provides tools for managing these files programmatically.
