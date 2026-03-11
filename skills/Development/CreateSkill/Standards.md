# CreateSkill Standards Reference

Canonical rules referenced across all CreateSkill workflows. Single source of truth -- do not duplicate these rules in workflow files.

---

## TitleCase Naming Convention

**All naming must use TitleCase (PascalCase).**

| Component | Format | Example |
|-----------|--------|---------|
| Skill directory | TitleCase | `Blogging`, `Daemon`, `CreateSkill` |
| Workflow files | TitleCase.md | `Create.md`, `UpdateDaemonInfo.md` |
| Reference docs | TitleCase.md | `ProsodyGuide.md`, `ApiReference.md` |
| Tool files | TitleCase.ts | `ManageServer.ts` |
| Help files | TitleCase.help.md | `ManageServer.help.md` |

### Wrong vs Correct Examples

| Type | Wrong | Correct |
|------|-------|---------|
| Skill directory | `createskill`, `create-skill` | `Createskill` |
| Multi-word skill | `create_skill`, `CREATE_SKILL` | `CreateSkill` |
| Workflow file | `create.md`, `CREATE.md` | `Create.md` |
| Multi-word workflow | `update-info.md`, `UPDATE_INFO.md` | `UpdateInfo.md` |
| Reference doc | `api-reference.md` | `ApiReference.md` |
| Tool file | `manage-server.ts` | `ManageServer.ts` |

---

## Final Verification Checklist

Use this checklist at the end of any Create, Update, Canonicalize, or Validate workflow.

### Naming (TitleCase)
- [ ] Skill directory uses TitleCase (e.g., `Blogging`, `Daemon`)
- [ ] All workflow files use TitleCase (e.g., `Create.md`, `UpdateInfo.md`)
- [ ] All reference docs use TitleCase (e.g., `ProsodyGuide.md`)
- [ ] All tool files use TitleCase (e.g., `ManageServer.ts`)
- [ ] Routing table workflow names match file names exactly

### YAML Frontmatter
- [ ] `name:` uses TitleCase
- [ ] `description:` is single-line with embedded `USE WHEN` clause
- [ ] No separate `triggers:` or `workflows:` arrays in YAML
- [ ] Description uses intent-based language
- [ ] Description is under 1024 characters

### Markdown Body
- [ ] `## Workflow Routing` section present with table format
- [ ] All workflow files have routing entries
- [ ] `## Examples` section with 2-3 concrete usage patterns

### Structure
- [ ] `Tools/` directory exists (even if empty)
- [ ] Workflows contain ONLY work execution procedures
- [ ] Reference docs live at skill root (not in Workflows/)
- [ ] No `backups/` directory inside skill

### CLI-First Integration (for skills with CLI tools)
- [ ] CLI tools expose configuration via flags (see CLIFIRSTARCHITECTURE.md)
- [ ] Workflows that call CLI tools have intent-to-flag mapping tables
- [ ] Flag mappings cover: mode selection, output options, post-processing (where applicable)

### Output Configuration (for skills that produce files)
- [ ] Output path documented if skill produces files
- [ ] Uses OutputPathResolver for path generation
- [ ] Respects `MEMORY/[SkillName]/YYYY-MM-DD/` convention (or documents override)

### Skill Invocation Patterns (for skills that invoke other skills)
- [ ] Uses CORE/Tools/SkillInvoker for programmatic skill invocation
- [ ] No raw `Bun.spawn` calls to claude for skill invocation
- [ ] All invoked skill names exist in skill registry

### Infrastructure Utilization (for all skills with Tools/)
- [ ] No raw `JSON.parse(Bun.file(...))` - use StateManager
- [ ] No `curl localhost:8888` or raw fetch to voice server - use NotificationService
- [ ] No `Bun.spawn(["claude"...])` for skills - use SkillInvoker
- [ ] No direct `fetch()` for external APIs without caching consideration
- [ ] No `ANTHROPIC_API_KEY` or direct SDK usage - use Inference.ts
- [ ] File outputs use OutputPathResolver for consistent paths
