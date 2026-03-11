# Update Workflow

Sync Browser skill capabilities with latest Playwright features.

## When to Use

- Monthly capability check
- After Playwright releases new version
- If browser commands fail unexpectedly

## Official Source

**Library:** [Playwright](https://playwright.dev)
**Package:** `playwright`

## Steps

### 1. Check Latest Playwright Version

```bash
# Check installed version
bun pm ls | grep playwright

# Check npm for latest
npm info playwright version
```

### 2. Review Playwright Changelog

```bash
# Get latest changelog
curl -s https://raw.githubusercontent.com/microsoft/playwright/main/CHANGELOG.md | head -200
```

### 3. Compare with Browse.ts CLI

| Playwright Feature | Browse.ts Command | Status |
|-------------------|-------------------|--------|
| navigate | `Browse.ts <url>` | Implemented |
| screenshot | `Browse.ts screenshot` | Implemented |
| click | `Browse.ts click <sel>` | Implemented |
| fill | `Browse.ts fill <sel> <val>` | Implemented |
| type | `Browse.ts type <sel> <text>` | Implemented |
| evaluate | `Browse.ts eval "<js>"` | Implemented |
| console logs | `Browse.ts errors/warnings/console` | Implemented |
| network monitoring | `Browse.ts network/failed` | Implemented |
| accessibility snapshot | `Browse.ts snapshot` | Implemented |
| state save/load | `Browse.ts state-save/state-load` | Implemented |

### 4. Update Browse.ts if Needed

For missing critical functionality:
1. Add method to `index.ts`
2. Add CLI command to `Tools/Browse.ts`
3. Update SKILL.md documentation

### 5. Test

```bash
# Verify basic operations
bun run ~/.claude/skills/Development/Browser/Tools/Browse.ts https://example.com
bun run ~/.claude/skills/Development/Browser/Tools/Browse.ts screenshot /tmp/test.png
bun run ~/.claude/skills/Development/Browser/Tools/Browse.ts snapshot
```

## Version Tracking

```
# Last sync: 2026-02-20
# Playwright: latest
# Browse.ts CLI coverage: 95%+ of core features
# Known gaps: Tracing (Phase 1 planned), Video recording
```
