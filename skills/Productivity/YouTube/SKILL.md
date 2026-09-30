---
name: YouTube
description: Shortcut alias for YouTubeCuration — Jm's on-demand YouTube prune/steer/wl curation and status view. Delegates to the same scripts.
---

# YouTube (alias for YouTubeCuration)

This is a memorable shortcut so `/youtube` (the spec's actual command word)
routes correctly. The real skill lives at
`~/.claude/skills/Productivity/YouTubeCuration/`.

## INVOCATION

**Default (`/youtube` with no args) or `/youtube status`:**

```bash
bun ~/.claude/skills/Productivity/YouTubeCuration/Tools/Status.ts
```

Zero writes, zero browser/API calls — local reads only.

**`/youtube prune`, `/youtube wl`, `/youtube steer <prose>`:** read
`~/.claude/skills/Productivity/YouTubeCuration/SKILL.md` in full and follow
its Command surface / Session split / Preview rule sections. As of this
build slice these modes are **not yet implemented** — say so plainly rather
than guessing at behavior.

USE WHEN:
- Jm types `/youtube`, `/youtube status`, `/youtube prune`, `/youtube wl`,
  `/youtube steer ...`
- Jm asks anything about his YouTube watch history, Watch Later queue,
  YouTube recommendations, or declared YouTube intent.

For everything else (architecture, data model, the honesty clause, session
gating, pacing rules), read
`~/.claude/skills/Productivity/YouTubeCuration/SKILL.md`.
