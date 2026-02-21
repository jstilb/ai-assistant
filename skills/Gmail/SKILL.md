---
name: Gmail
description: Gmail automation and email management via CLI. USE WHEN send email, draft email, search emails, gmail inbox, email labels, email filters, batch email operations, read email.
---

# Gmail - Email Automation System

Direct interface to Gmail for sending, searching, organizing, and automating email workflows.

---

## CLI Commands Available

| Command | Purpose |
|---------|---------|
| `kaya-cli gmail send` | Send a new email |
| `kaya-cli gmail draft` | Create email draft |
| `kaya-cli gmail read` | Get email content by ID |
| `kaya-cli gmail search` | Find emails with Gmail query syntax |
| `kaya-cli gmail modify` | Add/remove labels |
| `kaya-cli gmail delete` | Permanently delete email |
| `kaya-cli gmail list-labels` | Get all available labels |
| `kaya-cli gmail batch-modify` | Bulk label changes |
| `kaya-cli gmail batch-delete` | Bulk delete |
| `kaya-cli gmail create-label` | Create new label |
| `kaya-cli gmail update-label` | Modify label settings |
| `kaya-cli gmail delete-label` | Remove a label |
| `kaya-cli gmail get-or-create-label` | Find or create label |
| `kaya-cli gmail create-filter` | Create email filter |
| `kaya-cli gmail list-filters` | Get all filters |
| `kaya-cli gmail get-filter` | Get filter details |
| `kaya-cli gmail delete-filter` | Remove filter |
| `kaya-cli gmail download-attachment` | Save attachment to disk |

---

## Workflow Routing

| Trigger | Workflow | Action |
|---------|----------|--------|
| "send email", "email to" | **SendEmail** | Compose and send |
| "draft email" | **DraftEmail** | Create draft for review |
| "search emails", "find emails" | **SearchEmails** | Query inbox |
| "inbox", "check email", "unread" | **InboxReview** | Review recent emails |
| "email labels", "organize emails" | **LabelManagement** | Label operations |
| "email filter", "auto-sort" | **FilterManagement** | Create/manage filters |
| "clean inbox", "archive emails" | **InboxCleanup** | Batch organization |

---

## Quick Reference

### Gmail Search Syntax

| Query | Purpose |
|-------|---------|
| `from:example@gmail.com` | From specific sender |
| `to:me` | Sent to you |
| `subject:invoice` | Subject contains word |
| `has:attachment` | Has attachments |
| `is:unread` | Unread emails |
| `is:starred` | Starred emails |
| `after:2026/01/01` | After date |
| `before:2026/01/31` | Before date |
| `newer_than:7d` | Last 7 days |
| `label:important` | Has specific label |
| `-label:promotions` | Exclude label |

### Common Label IDs

| Label | ID |
|-------|-----|
| Inbox | `INBOX` |
| Starred | `STARRED` |
| Sent | `SENT` |
| Drafts | `DRAFT` |
| Spam | `SPAM` |
| Trash | `TRASH` |
| Important | `IMPORTANT` |
| Unread | `UNREAD` |

---

## Execution Steps

### SendEmail Workflow

1. **Parse recipient** - Extract email address
2. **Compose message:**
   - Subject from user or inferred
   - Body content (plain or HTML)
   - Attachments if specified
3. **Validate** before sending
4. **Send** via `send_email`
5. **Confirm** with message ID

### DraftEmail Workflow

1. **Parse content** same as SendEmail
2. **Create draft** via `draft_email`
3. **Return draft link** for user review

### SearchEmails Workflow

1. **Build query** from user intent:
   - "emails from John" → `from:john`
   - "unread this week" → `is:unread newer_than:7d`
2. **Execute search** via `search_emails`
3. **Return results** with summary
4. **Offer actions:** read, archive, delete

### InboxReview Workflow

1. **Search unread** via `search_emails` with `is:unread`
2. **Group by sender/topic**
3. **Summarize:**
   - Count by category
   - High priority flagged
   - Action items
4. **Offer batch actions**

### LabelManagement Workflow

1. **List labels** via `list_email_labels`
2. **Create/modify** as requested
3. **Apply to emails** via `modify_email`

### FilterManagement Workflow

1. **Parse criteria:**
   - From sender
   - Subject keywords
   - Has attachment
2. **Define actions:**
   - Apply label
   - Archive
   - Mark important
3. **Create filter** via `create_filter` or template

### InboxCleanup Workflow

1. **Find candidates:**
   - Older than X days
   - From newsletters
   - Already read
2. **Preview actions** for user
3. **Execute batch** via `batch_modify_emails`
4. **Report results**

---

## Filter Templates

Available via `create_filter_from_template`:

| Template | Description |
|----------|-------------|
| `fromSender` | Filter by sender email |
| `withSubject` | Match subject text |
| `withAttachments` | Has attachments |
| `largeEmails` | Above size threshold |
| `containingText` | Body contains text |
| `mailingList` | Mailing list identifier |

---

## Examples

**Example 1: Send an email**
```
User: "Email john@example.com about the meeting tomorrow"
Kaya:
→ Composes email with subject inferred from context
→ Asks for body content or generates draft
→ Sends via send_email
→ "Email sent to john@example.com"
```

**Example 2: Check inbox**
```
User: "Check my unread emails"
Kaya:
→ Searches is:unread
→ Groups: 3 from work, 5 newsletters, 2 personal
→ "12 unread: 3 work emails need attention, 5 newsletters (archive?)"
```

**Example 3: Create email filter**
```
User: "Auto-archive emails from newsletters@company.com"
Kaya:
→ Creates filter with fromSender template
→ Action: remove INBOX label (archive)
→ "Filter created: emails from newsletters@company.com will auto-archive"
```

**Example 4: Batch cleanup**
```
User: "Archive all promotional emails older than 30 days"
Kaya:
→ Searches: category:promotions older_than:30d
→ Shows count: "Found 247 emails"
→ After approval, batch archives
→ "Archived 247 promotional emails"
```

**Example 5: Search with attachment download**
```
User: "Find the invoice from Amazon last month"
Kaya:
→ Searches: from:amazon subject:invoice newer_than:30d has:attachment
→ Finds match, offers to download
→ Downloads via download_attachment
→ "Saved invoice.pdf to Downloads"
```

---

## Safety Rules

**Requires User Approval:**
- Sending emails (always confirm recipient and content)
- Batch delete operations
- Creating filters that auto-delete

**Allowed Without Approval:**
- Searching emails
- Reading email content
- Creating drafts
- Listing labels/filters
- Labeling emails

---

## Customization

### Default Search Behavior
- **Max results:** 20 emails per search (adjustable with `--max-results`)
- **Date range:** No default limit; use `newer_than:` or `older_than:` to scope
- **Output format:** Plain text by default; use `--format json` for structured data

### Cleanup Thresholds
Configure default age thresholds for InboxCleanup:
- **Promotions:** Archive after 7 days read
- **Social:** Archive after 7 days read
- **Updates:** Archive after 14 days read
- **Newsletters:** Archive after 7 days read (label first)

### Contact Lookup
Recipient names are resolved via `~/.claude/skills/CORE/USER/CONTACTS.md`. Add contacts there to enable name-based addressing (e.g., "email Mom" resolves to the stored email address).

---

## Voice Notification

Use `notifySync()` from `skills/CORE/Tools/NotificationService.ts`

```bash
curl -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message":"Email operation completed","voice_id":"XrExE9yKIg1WjnnlVkGX","title":"Gmail"}'
```

Notify on:
- Email sent successfully
- Draft created
- Batch cleanup completed
- Search results ready (large result sets)

---

## Integration

### Uses
- **Gmail MCP** - All email operations
- **CORE/USER/CONTACTS.md** - Lookup recipient info by name

### Feeds Into
- **Kaya** - Extract action items from emails into task manager
- **CalendarAssistant** - Detect meeting invites and scheduling requests

### MCPs Used
- **gmail** - Full email automation

### Overlap Note
The **UnixCLI** skill contains a `Workflows/Gmail.md` that documents lower-level `kaya-cli gmail` and `gog gmail` CLI syntax. The **Gmail skill is the authoritative skill** for all email operations, routing, and workflows. UnixCLI's Gmail workflow serves as a reference for raw CLI commands and authentication setup only.

---

**Last Updated:** 2026-02-06
