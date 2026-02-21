# /work - Autonomous Work Command

On-demand autonomous execution of development, research, and content work.

## Usage

```
/work [dev|research|content|next|status] [topic/type]
```

## Arguments

| Argument | Description |
|----------|-------------|
| `dev` | Pick up development task from Kaya project, code, test, report |
| `research [topic]` | Multi-agent research on specified topic |
| `content [type]` | Generate diagrams, docs, or social content |
| `next` | Auto-select next task from AI queue |
| `status` | Show current work in progress |
| `approve` | Review and approve pending social content |

## Content Types

```
/work content diagram      # Mermaid diagram
/work content flowchart    # Process flowchart
/work content architecture # System architecture diagram
/work content docs         # Markdown documentation
/work content social       # Draft social post (needs approval)
```

## Examples

```
/work dev                          # Pick up next dev task
/work research "MCP best practices" # Research topic with 3 agents
/work content diagram              # Generate a diagram
/work next                         # Auto-select from queue
/work approve                      # Review pending social posts
```

## Execution

When this command is invoked, route to the AutonomousWork skill:

```
Read and execute: ~/.claude/skills/AutonomousWork/SKILL.md
```

The skill will route to the appropriate workflow based on the argument provided.

## Safety Rules

**No Approval Needed:**
- Reading code, files, documentation
- Running tests (non-destructive)
- Generating reports and analysis
- Creating drafts in MEMORY/WORK/

**Requires User Approval:**
- Posting to social media (Bluesky, LinkedIn)
- Deploying to production
- Deleting files or data
- Git push to main branches

## Output

- Development: `~/.claude/MEMORY/WORK/dev/YYYY-MM-DD_task-name.md`
- Research: `~/.claude/MEMORY/WORK/research/YYYY-MM-DD_topic.md`
- Content: `~/.claude/MEMORY/WORK/content/YYYY-MM-DD_type.md`
- Social drafts: `~/.claude/MEMORY/WORK/content/social/pending/`
