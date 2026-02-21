# PrivateSystemAudit Workflow

**Purpose:** Comprehensive integrity and security audit of the private Kaya instance. Combines multiple validation workflows into a single thorough system check.

**Triggers:** "system audit", "private audit", "full system check", "comprehensive audit", or called by other workflows when deep validation is needed.

---

## Voice Notification

-> Use `notifySync()` from `skills/CORE/Tools/NotificationService.ts`

```typescript
notifySync("Running comprehensive system audit");
```

Running the **PrivateSystemAudit** workflow from the **System** skill...

---

## Overview

This workflow orchestrates multiple checks into a comprehensive audit:

1. **Repository Validation** - Correct remotes, no contamination
2. **Secret Scanning** - No exposed credentials
3. **Integrity Check** - No broken references
4. **Privacy Check** - Proper data isolation
5. **Configuration Validation** - Valid settings.json

---

## Execution

### Phase 1: Repository Validation

```bash
# Verify we're in private repo
pwd  # Should be ~/.claude

# Verify correct remote
git remote -v  # Should NOT point to danielmiessler/Kaya.git

# Check for uncommitted sensitive files
git status | grep -E "secrets|credentials|\.env"
```

**Pass criteria:**
- In `~/.claude` directory
- Remote points to private repository
- No sensitive files in git status

### Phase 2: Secret Scanning

Execute `SecretScanning.md`:

```bash
# Run TruffleHog scan
trufflehog filesystem ~/.claude --no-update 2>/dev/null || echo "TruffleHog not installed"

# Run Kaya SecretScan tool
bun ~/.claude/skills/CORE/Tools/SecretScan.ts
```

**Pass criteria:**
- ✅ No secrets detected in tracked files
- ✅ secrets.json is gitignored
- ✅ No API keys in settings.json

### Phase 3: Integrity Check

Execute `IntegrityCheck.md`:

```bash
# Check for broken skill references
bun ~/.claude/skills/System/Tools/IntegrityCheck.ts 2>/dev/null || echo "Running manual checks"

# Verify critical files exist
ls ~/.claude/settings.json
ls ~/.claude/skills/CORE/SKILL.md
ls ~/.claude/hooks/LoadContext.hook.ts
```

**Pass criteria:**
- ✅ All referenced files exist
- ✅ No circular dependencies
- ✅ Critical system files present

### Phase 4: Privacy Check

Execute `PrivacyCheck.md`:

```bash
# Check USER/ content isolation
ls -la ~/.claude/skills/*/USER/ 2>/dev/null | head -5

# Verify no personal data in SYSTEM/ directories
grep -r "personal\|private\|secret" ~/.claude/skills/*/SYSTEM/ 2>/dev/null | head -5

# Check MEMORY isolation
ls ~/.claude/MEMORY/WORK/ | head -5
```

**Pass criteria:**
- ✅ USER/ directories contain only personal content
- ✅ SYSTEM/ directories contain only generic content
- ✅ MEMORY/ properly isolated from public content

### Phase 5: Configuration Validation

```bash
# Validate settings.json structure
bun -e "
const settings = require('$HOME/.claude/settings.json');
console.log('daidentity:', !!settings.daidentity);
console.log('principal:', !!settings.principal);
console.log('hooks:', !!settings.hooks);
"

# Check secrets.json exists and is gitignored
ls ~/.claude/secrets.json 2>/dev/null && echo "secrets.json exists"
grep "secrets.json" ~/.claude/.gitignore && echo "secrets.json is gitignored"
```

**Pass criteria:**
- ✅ settings.json is valid JSON
- ✅ Required sections present (daidentity, principal, hooks)
- ✅ secrets.json exists and is gitignored

---

## Audit Report Template

```markdown
# Kaya System Audit Report
**Date:** YYYY-MM-DD HH:MM
**Auditor:** Kaya (System Skill)

## Summary
| Phase | Status | Issues |
|-------|--------|--------|
| Repository Validation | ✅/⚠️/⛔ | None/List |
| Secret Scanning | ✅/⚠️/⛔ | None/List |
| Integrity Check | ✅/⚠️/⛔ | None/List |
| Privacy Check | ✅/⚠️/⛔ | None/List |
| Configuration | ✅/⚠️/⛔ | None/List |

## Overall Status: PASS/WARN/FAIL

## Details
[Detailed findings for each phase]

## Recommendations
[Actions needed to resolve any issues]
```

---

## Issue Severity Levels

| Level | Meaning | Action |
|-------|---------|--------|
| ⛔ CRITICAL | Security risk, data exposure | Stop work, fix immediately |
| ⚠️ WARNING | Potential issue, degraded functionality | Fix soon |
| 📝 INFO | Recommendation, best practice | Consider fixing |
| ✅ PASS | No issues detected | Continue |

---

## When to Run

- Weekly maintenance (AutoMaintenance skill)
- Before major releases or deployments
- After significant system changes
- When security concerns arise
- As part of incident response

---

## Output Locations

| Output | Location |
|--------|----------|
| Audit Report | `MEMORY/AUDITS/YYYY-MM-DD-system-audit.md` |
| Secret Scan Results | `MEMORY/VALIDATION/YYYY/MM/secret-scan-*.jsonl` |
| Integrity Results | `MEMORY/VALIDATION/YYYY/MM/integrity-*.jsonl` |

---

## Automated Scheduling

This workflow can be scheduled via launchd:

```xml
<!-- ~/.claude/launchd/com.pai.system-audit.plist -->
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.pai.system-audit</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/claude</string>
        <string>-p</string>
        <string>Run PrivateSystemAudit workflow</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Weekday</key>
        <integer>0</integer>
        <key>Hour</key>
        <integer>3</integer>
    </dict>
</dict>
</plist>
```

---

## Related Workflows

- `IntegrityCheck.md` - Subset: broken references only
- `SecretScanning.md` - Subset: secrets only
- `PrivacyCheck.md` - Subset: privacy only
- `DocumentSession.md` - Document audit findings
