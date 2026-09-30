---
name: Media
description: Shortcut alias for AppUsageTracker — Jm's G37 cross-device media-consumption tracker. Use this for any "media stats", "low-value media", "G37", or "media consumption" question. Delegates to the same scripts.
---

# Media (alias for AppUsageTracker)

This is a memorable shortcut. The real skill lives at `~/.claude/skills/Productivity/AppUsageTracker/`.

## INVOCATION

**Default (`/media` with no args):** show today's metric + freshness.

```bash
bun ~/.claude/skills/Productivity/AppUsageTracker/Tools/Freshness.ts
```

**`/media sync` or `/media now`:** force-poll all devices, recompute today, report.

```bash
bash ~/.claude/skills/Productivity/AppUsageTracker/bin/sync-now.sh
```

**`/media rebuild` or `/media recompute`:** rebuild all daily_metrics from events (use after editing tier lists in `Config.ts`).

```bash
bun ~/.claude/skills/Productivity/AppUsageTracker/Tools/MetricCalc.ts --force
```

**`/media apps` or `/media top`:** show top 15 apps last 7 days, broken down by device.

```bash
bun -e "import { Db } from '~/.claude/skills/Productivity/AppUsageTracker/Tools/Db.ts';
const db = await Db.open();
const rows = await db.queryAll(\`SELECT device, app, ROUND(SUM(duration_sec)/60,1)::DOUBLE AS min, COUNT(*)::INT AS n FROM events WHERE ts_start >= today() - INTERVAL 7 DAY GROUP BY device, app ORDER BY min DESC LIMIT 15\`);
for (const r of rows) console.log(\`  \${String(r.device).padEnd(7)} \${String(r.app ?? '(null)').padEnd(35)} \${String(r.min).padStart(7)} min (\${r.n} events)\`);
db.close();"
```

USE WHEN:
- Jm types `/media`, `/media sync`, `/media rebuild`, `/media apps`, etc.
- Jm asks anything about media consumption, G37, low-value media, screen time, app usage breakdown, "how am I doing on media", "what's my rolling avg", etc.

For everything else (architecture, config edits, troubleshooting), read `~/.claude/skills/Productivity/AppUsageTracker/SKILL.md`.
