---
name: OSINT
description: Open source intelligence gathering. USE WHEN OSINT, due diligence, background check, research person, company intel, investigate. SkillSearch('osint') for docs.
---
# OSINT Skill

Open Source Intelligence gathering for authorized investigations.

---

## Voice Notification

→ Use `notifySync()` from `skills/CORE/Tools/NotificationService.ts`

## Workflow Routing

| Investigation Type | Workflow | Context |
|-------------------|----------|---------|
| People lookup | `Workflows/PeopleLookup.md` | `PeopleTools.md` |
| Company lookup | `Workflows/CompanyLookup.md` | `CompanyTools.md` |
| Investment due diligence | `Workflows/CompanyDueDiligence.md` | `CompanyTools.md` |
| Entity/threat intel | `Workflows/EntityLookup.md` | `EntityTools.md` |

---

## Trigger Patterns

**People OSINT:**
- "do OSINT on [person]", "research [person]", "background check on [person]"
- "who is [person]", "find info about [person]", "investigate this person"
-> Route to `Workflows/PeopleLookup.md`

**Company OSINT:**
- "do OSINT on [company]", "research [company]", "company intelligence"
- "what can you find about [company]", "investigate [company]"
-> Route to `Workflows/CompanyLookup.md`

**Investment Due Diligence:**
- "due diligence on [company]", "vet [company]", "is [company] legitimate"
- "assess [company]", "should we work with [company]"
-> Route to `Workflows/CompanyDueDiligence.md`

**Entity/Threat Intel:**
- "investigate [domain]", "threat intelligence on [entity]", "is this domain malicious"
- "research this threat actor", "check [domain]", "analyze [entity]"
-> Route to `Workflows/EntityLookup.md`

---

## Authorization (REQUIRED)

**Before ANY investigation, complete the full authorization checklist.**
See [Authorization Verification Checklist](./EthicalFramework.md#authorization-verification-checklist) - **STOP if any requirement is unmet.**

---

## Resource Index

| File | Purpose |
|------|---------|
| `EthicalFramework.md` | Authorization, legal, ethical boundaries |
| `Methodology.md` | Collection methods, verification, reporting |
| `PeopleTools.md` | People search, social media, public records |
| `CompanyTools.md` | Business databases, DNS, tech profiling |
| `EntityTools.md` | Threat intel, scanning, malware analysis |

---

## Integration

**Researcher types:** ClaudeResearcher, GeminiResearcher, GrokResearcher

See [Methodology.md - Integration Points](./Methodology.md#integration-points) for fleet sizes, timeout management, and skill invocations.
See [Methodology.md - File Organization](./Methodology.md#file-organization) for active investigation and archive directory structures.

---

## Ethical Guardrails

See [Ethical Boundaries](./EthicalFramework.md#ethical-boundaries) for the complete ALWAYS/NEVER list and [Red Lines](./EthicalFramework.md#red-lines-never-cross) for prohibited actions.

---

**Version:** 2.1 (Audit Remediation)
**Last Updated:** February 2026
