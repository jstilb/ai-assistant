# skills/CORE/USER/ -- Personalization Layer

> This directory contains your personal configuration and identity files.
> Most files are excluded from the public repository. This README explains
> the personalization system so you can set up your own.

## Purpose

The USER directory is where you customize Kaya to yourself. It stores your identity, preferences, goals, and personal information that Kaya uses to provide personalized assistance.

## Structure

```
USER/
  DAIDENTITY.md            # [INCLUDED] AI personality and identity config
  KAYASECURITYSYSTEM/      # [INCLUDED] Security patterns and rules
  TERMINAL/                # [INCLUDED] Terminal (Kitty) configuration
  STATUSLINE/              # [INCLUDED] Status line configuration

  # --- Files you create (excluded from public repo) ---
  ABOUTME.md               # Your personal bio and background
  CONTACTS.md              # Your contacts directory
  JMIDENTITY.md            # Your identity and communication style
  RESUME.txt               # Your resume (text format)
  RESUME.pdf               # Your resume (PDF format)
  BASICINFO.md             # Basic personal information
  UserContext.md            # Dynamic user context

  # --- Personal directories (excluded) ---
  TELOS/                   # Goal tracking system (see TELOS/README.md)
  HEALTH/                  # Health tracking
  FINANCES/                # Financial information
  BUSINESS/                # Business information
  WORK/                    # Work-related notes

  # --- System files (included) ---
  ARCHITECTURE.md          # System architecture notes
  TECHSTACKPREFERENCES.md  # Your tech stack preferences
  PRODUCTIVITY.md          # Productivity patterns
  RESPONSEFORMAT.md        # Response format preferences
  ASSETMANAGEMENT.md       # Deployment configuration
  config/                  # Additional config files
```

## Getting Started

1. **DAIDENTITY.md** -- Already included. Edit to set your AI's name, color, and voice ID.
2. **Create ABOUTME.md** -- Write a brief bio so Kaya knows your background.
3. **Create BASICINFO.md** -- Add your name, timezone, and key preferences.
4. **Run `bun run install.ts`** -- The installer wizard helps configure these files.

## Example ABOUTME.md

```markdown
# About Me

I'm a software engineer based in San Francisco. I work primarily with
TypeScript and Python, building data pipelines and web applications.

## Interests
- Distributed systems
- Machine learning
- Board games

## Work Style
- I prefer direct, concise communication
- I like seeing code examples over abstract explanations
- I work best in focused 2-hour blocks
```
