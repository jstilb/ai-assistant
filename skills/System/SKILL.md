---
name: System
description: System maintenance with three core operations - integrity check (find/fix broken references), document session (current transcript), document recent (catch-up since last update). Plus security workflows. USE WHEN integrity check, audit system, document session, document this session, document today, document recent, catch up docs, what's undocumented, check for secrets, security scan, privacy check, OR asking about past work ("we just worked on", "remember when we").
---
# System Skill

System validation, integrity audits, documentation tracking, and security scanning for the Kaya system.

## Visibility

This skill runs in the foreground so you can see all output, progress, and hear voice notifications as work happens. Documentation updates, integrity checks, and other system operations should be visible to maintain transparency.

---

## Voice Notification

-> Use `notifySync()` from `skills/CORE/Tools/NotificationService.ts`

---

## Workflow Routing

### Core Operations (The Three)

| Workflow | Trigger | Purpose | File |
|----------|---------|---------|------|
| **IntegrityCheck** | "integrity check", "audit system", "check references", "system health" | Find and fix broken references across the system | `Workflows/IntegrityCheck.md` |
| **DocumentSession** | "document session", "document today", "document this session", "log session" | Document current session's work from transcript | `Workflows/DocumentSession.md` |
| **DocumentRecent** | "document recent", "catch up docs", "what's undocumented", "document since last update" | Catch-up documentation for changes since last documented update | `Workflows/DocumentRecent.md` |

**Composition Rules:**
- Integrity Check → may produce fixes → Document Session
- After any session → Document Session
- Periodic catch-up → Document Recent

### Security Workflows

| Workflow | Trigger | File |
|----------|---------|------|
| **SecretScanning** | "check for secrets", "scan for credentials", "security scan" | `Workflows/SecretScanning.md` |
| **PrivacyCheck** | "privacy check", "check for sensitive data", "data isolation" | `Workflows/PrivacyCheck.md` |

### Utility Workflows

| Workflow | Trigger | File |
|----------|---------|------|
| **WorkContextRecall** | "we just worked on", "what did we do with", "remember when we", "didn't we already" | `Workflows/WorkContextRecall.md` |

**Note:** For public Kaya integrity ("check Kaya integrity", "audit Kaya packs"), use the Kaya skill → `KayaIntegrityCheck.md`

---

## Examples

### Core Operations

**Example 1: Integrity Check**
```
User: "Run an integrity check"
→ Invokes IntegrityCheck workflow
→ Spawns parallel agents to audit ~/.claude
→ Finds broken references, missing files
→ Returns list of issues found/fixed
```

**Example 2: Document Current Session**
```
User: "Document this session"
→ Invokes DocumentSession workflow
→ Reads current session transcript
→ Uses AI to extract what changed and why
→ Creates entry in MEMORY/KAYASYSTEMUPDATES/
```

**Example 3: Catch-up Documentation**
```
User: "What's undocumented? Catch up the docs."
→ Invokes DocumentRecent workflow
→ Finds last documented update timestamp
→ Compares git history since then
→ Generates documentation for missed changes
```

### Security Workflows

**Example 4: Secret Scanning**
```
User: "Check for secrets before I push"
→ Invokes SecretScanning workflow
→ Runs TruffleHog on specified directory
→ Reports any API keys, credentials found
```

### Utility

**Example 5: Recall Past Work**
```
User: "We just worked on the status line - why broken again?"
→ Invokes WorkContextRecall workflow
→ Searches MEMORY/, git history for "status line"
→ Presents timeline of changes and possible regression
```

---

## Quick Reference

### The Three Core Operations

| Operation | Input | Output | Duration |
|-----------|-------|--------|----------|
| **IntegrityCheck** | Codebase scan | List of broken refs found/fixed | ~2-5 min |
| **DocumentSession** | Session transcript | KAYASYSTEMUPDATES entry | ~30s |
| **DocumentRecent** | Git history since last update | Multiple KAYASYSTEMUPDATES entries | ~1-2 min |

### Composition Patterns

```
End of Session:     DocumentSession
After Refactoring:  IntegrityCheck → DocumentSession
Catch-up:           DocumentRecent
```

### Security Audits

| Audit Type | Tool | Scope | Duration |
|------------|------|-------|----------|
| Secret Scan | TruffleHog | Any directory | ~30s-2min |
| Privacy Check | grep/patterns | skills/ (excl USER/WORK) | ~30s |

### Documentation Format

**Verbose Narrative Structure:**
- **The Story** (1-3 paragraphs): Background, Problem, Resolution
- **How It Used To Work**: Previous state with bullet points
- **How It Works Now**: New state with improvements
- **Going Forward**: Future implications
- **Verification**: How we know it works

---

## When to Use

### Integrity Checks
- After major refactoring
- Before releasing updates
- Periodic system health checks
- When something "feels broken"
- Before pushing to public Kaya repo

### Documentation
- End of significant work sessions
- After creating new skills/workflows/tools
- When architectural decisions are made
- To maintain system history

### Security Scanning
- Before any git commit to public repos
- When auditing for credential leaks
- Periodic security hygiene checks
- After receiving external code/content

### Privacy Validation
- After working with USER/ or WORK/ content
- Before any public commits
- When creating new skills that might reference personal data
- Periodic audit to ensure data isolation

### Work Context Recall
- When user asks about past work ("we just fixed that")
- Questions about why decisions were made
- Finding artifacts from previous sessions
- Debugging something that was "already fixed"
- Resuming multi-session projects

---

## Tools

| Tool | Purpose | Location |
|------|---------|----------|
| **SecretScan.ts** | TruffleHog wrapper for credential detection | `CORE/Tools/SecretScan.ts` |
| **CreateUpdate.ts** | Create new system update entries | `Tools/CreateUpdate.ts` |
| **UpdateIndex.ts** | Regenerate index.json and CHANGELOG.md | `Tools/UpdateIndex.ts` |
| **UpdateSearch.ts** | Search and query system updates | `Tools/UpdateSearch.ts` |
| **ExtractArchitectureUpdates.ts** | Historical migration tool (one-time use) | `Tools/ExtractArchitectureUpdates.ts` |

## Templates

| Template | Purpose | Location |
|----------|---------|----------|
| **Update.md** | Template for system update entries | `Templates/Update.md` |

---

## Output Locations

| Output | Location |
|--------|----------|
| Integrity Reports | `MEMORY/STATE/integrity/YYYY-MM-DD.md` |
| System Updates | `MEMORY/KAYASYSTEMUPDATES/YYYY/MM/*.md` |
| Update Index | `MEMORY/KAYASYSTEMUPDATES/index.json` |
| Changelog | `MEMORY/KAYASYSTEMUPDATES/CHANGELOG.md` |

---

## Integration

### Uses
- **Glob/Grep** - File scanning for integrity checks
- **TruffleHog** - Secret scanning via SecretScan.ts
- **MEMORY/** - Session logs and update history
- **Transcript files** - Session context for documentation

### Feeds Into
- **MEMORY/KAYASYSTEMUPDATES/** - System change documentation
- **MEMORY/STATE/integrity/** - Integrity reports
- **All skills** - Maintains their references and health

### Related Skills
- **Kaya** - Public Kaya repository management (includes KayaIntegrityCheck)
- **CORE** - System architecture and memory documentation
- **SkillAudit** - Deep skill analysis and scoring
- **Evals** - Regression testing and capability verification

---

## SkillInvoker Integration (2026-02-02)

The System skill integrates with SkillInvoker for programmatic skill composition and documentation workflows.

### Fabric Patterns

| Pattern | Use Case |
|---------|----------|
| `extract_wisdom` | Extract key insights from session transcripts for KAYASYSTEMUPDATES |
| `summarize` | Condense verbose session logs into concise documentation |

**Example: Session Documentation**
```typescript
import { invokeSkill } from '~/.claude/skills/CORE/Tools/SkillInvoker';

// Extract wisdom from session transcript
const insights = await invokeSkill('Fabric', {
  pattern: 'extract_wisdom',
  input: sessionTranscript
});

// Create documentation entry
await invokeSkill('System', {
  workflow: 'DocumentSession',
  content: insights.output
});
```

### Prompting Templates

| Template | Purpose |
|----------|---------|
| `Briefing.hbs` | Generate handoff context for capture workflows |

**Example: Capture Handoff**
```typescript
import { invokeSkill } from '~/.claude/skills/CORE/Tools/SkillInvoker';

// Generate briefing from template
const briefing = await invokeSkill('Prompting', {
  template: 'Briefing.hbs',
  context: {
    sessionId: currentSession.id,
    changes: recentChanges,
    nextSteps: pendingTasks
  }
});
```

### Composition Pattern

```typescript
// Full documentation workflow with SkillInvoker
async function documentAndBrief(transcript: string) {
  // 1. Extract insights via Fabric
  const wisdom = await invokeSkill('Fabric', {
    pattern: 'extract_wisdom',
    input: transcript
  });

  // 2. Create system update
  await invokeSkill('System', {
    workflow: 'DocumentSession',
    content: wisdom.output
  });

  // 3. Generate handoff briefing
  return await invokeSkill('Prompting', {
    template: 'Briefing.hbs',
    context: { summary: wisdom.output }
  });
}
```

---

**Last Updated:** 2026-02-02
