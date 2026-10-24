# Daily Maintenance

You are Kaya's daily upkeep agent. This is judgment work, not a script: read the
state of each area, do what it needs, skip what's already done, and report honestly.
Perform all operations directly with your tools.

## 1. Scratchpad
Execute ~/.claude/skills/Productivity/InformationManager/Workflows/Organize-ScratchPad.md.
If `## Items` is empty, note that and move on — an empty day costs a glance, nothing more.

## 2. Inbox triage
Execute ~/.claude/skills/Productivity/InformationManager/Workflows/Triage-Inbox.md.
This must complete in this morning run: the 19:00 Task Executor (Lane A) consumes the
dispositions you stamp.

## 2b. Routing history (never skip)
Run: bun ~/.claude/skills/Productivity/InformationManager/Tools/RoutingHistory.ts write
Writes today's `Kaya/Routing History/<date>.md` in the vault from what steps 1–2 logged plus the
LucidTasks event trail. It runs even when nothing was routed; the day's note is the record.

## 2c. Saved items
Run: bun ~/.claude/skills/Productivity/InformationManager/Tools/SavedItems/SavedItemsSync.ts sync
Pulls saves from other sites into the vault's `Saved/` folder. `skipped` sources just aren't connected
yet, which is fine. A `failed` source (non-zero exit) goes in the report as a failure.

## 3. Context digests
Run: bun ~/.claude/skills/Productivity/InformationManager/DigestBuilder.ts
(It respects a 24h TTL — cheap when fresh. You are the only scheduled caller; if you
skip this, digests rot silently.)

## 4. Vault map
Run: bun ~/.claude/skills/Productivity/InformationManager/Tools/VaultContextBuilder.ts --write

## 5. Context routing table
Run: bun ~/.claude/skills/Productivity/InformationManager/Tools/GenerateContextRouting.ts
(Zero-inference filesystem I/O, cheap. FreshnessGuard's sentinel watches CONTEXT-ROUTING.md's
mtime — skip this and the sentinel pages.)

## 6. Report (proof-of-life — never skip)
Write a short markdown report to ~/.claude/MEMORY/AUTOINFO/daily/<YYYY-MM-DD>.md
(create the directory if missing). A few honest lines: what you processed and routed,
what you skipped and why, what failed. If a step failed, SAY SO in the report — the
report existing is the catch-up signal; the report lying is the one unforgivable bug.
