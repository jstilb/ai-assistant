# Generate Briefing Workflow

Generate and deliver a personalized daily briefing.

## Trigger

"morning briefing", "daily briefing", "start my day", "what's on my schedule"

## Steps

1. **Load Configuration**
   - Read `BriefingConfig.yaml` for enabled sections and delivery settings
   - Load `settings.json` for user identity

2. **Execute Blocks** (in priority order)
   | Block | Description | Data Source |
   |-------|-------------|-------------|
   | goals | WIGs and missions | TELOS/*.md |
   | approvalQueue | Pending approvals | QUEUES/approvals.jsonl |
   | weather | Current conditions | wttr.in / kaya-cli weather |
   | calendar | Today's events | kaya-cli gcal agenda |
   | lucidTasks | Due/overdue tasks | kaya-cli tasks |
   | news | Multi-topic news | Web search |

3. **Format Output**
   - Markdown (full written log)
   - Voice summary (16 words max, key info)
   - Telegram message (formatted for mobile)
   - Push notification (one-liner)

4. **Deliver**
   - Write to `MEMORY/BRIEFINGS/{date}.md`
   - Send voice via NotificationService
   - Send Telegram via TelegramClient
   - Send push via ntfy

## CLI Usage

```bash
# Generate and deliver
bun ~/.claude/skills/DailyBriefing/Tools/BriefingGenerator.ts

# Preview without delivery
bun ~/.claude/skills/DailyBriefing/Tools/BriefingGenerator.ts --dry-run

# JSON output
bun ~/.claude/skills/DailyBriefing/Tools/BriefingGenerator.ts --json

# Skip specific channels
bun ~/.claude/skills/DailyBriefing/Tools/BriefingGenerator.ts --skip-voice --skip-telegram
```

## Configuration

Edit `BriefingConfig.yaml` to customize:

### Enable/Disable Sections

```yaml
sections:
  goals:
    enabled: true
    priority: 1  # Lower = earlier in briefing
```

### Configure Delivery

```yaml
delivery:
  telegram:
    enabled: true
  voice:
    enabled: true
  push:
    enabled: true
  writtenLog:
    enabled: true
    path: "MEMORY/BRIEFINGS"
```

### Customize News Topics

```yaml
sections:
  news:
    enabled: true
    priority: 6
    settings:
      maxArticlesPerTopic: 3
      topics:
        - name: "AI"
          keywords: ["artificial intelligence news", "LLM developments"]
        - name: "Local"
          keywords: ["San Diego news"]
```

## Block Development

Each block implements:

```typescript
interface BlockResult {
  blockName: string;
  success: boolean;
  data: Record<string, unknown>;
  markdown: string;      // Section markdown
  summary: string;       // One-line for voice/push
  error?: string;
}

export async function execute(config: BlockConfig): Promise<BlockResult>;
```

## Scheduled Execution

Cron job runs at 8:00 AM daily:

```yaml
# MEMORY/daemon/cron/jobs/daily-briefing-v2.yaml
id: daily-briefing-v2
schedule: "0 8 * * *"
task: bun ~/.claude/skills/DailyBriefing/Tools/BriefingGenerator.ts
```

## Example Output

```markdown
# Good morning, User - Monday, February 3, 2026

## Goals

| WIG | Status | Metric |
|-----|--------|--------|
| G0: Decrease Low-Value Media | In Progress | 5.3 → 3.0 hrs |
| G1: Make 2 Good Friends | In Progress | 0/2 |

**Focus:** Focus on G0: Decrease Low-Value Media Consumption

## Approval Queue

**Awaiting Approval (1):**
- [ml18vdlo] Deploy to production **HIGH** (4d ago)

**Pending Review (9):**
- [ml5x7f7b] Simulation skill for AI agent testing (14h ago)

## Weather

**San Diego, CA:** 62°F, Partly Cloudy
**Today:** High 68°F, Low 55°F

## Calendar

3 events today:
- 9:00 AM - Team standup
- 2:00 PM - Client call

## Tasks Due Today

No tasks due today.

## News

### AI
- Claude 4 released with improved reasoning...

### Local San Diego
- City council approves new transit plan...
```
