# Gmail Workflow (gog)

Gmail operations via gogcli (gog) CLI.

## Prerequisites

- gog installed (`kaya-cli gmail --help`)
- OAuth2 authentication configured
- Gmail API enabled
- Default account set (`export GOG_ACCOUNT=email@gmail.com`)

## Authentication

```bash
# Initial setup
bash ~/.claude/tools/UnixCLI/configure-google-auth.sh

# List accounts
gog auth list

# Set default account
export GOG_ACCOUNT="your-email@gmail.com"

# Add to ~/.zshrc for persistence
echo 'export GOG_ACCOUNT="your-email@gmail.com"' >> ~/.zshrc
```

## Common Operations

### View Inbox

```bash
# Recent emails (use search with no query)
gog gmail search ""

# Unread emails
gog gmail search "is:unread"

# Search by subject
gog gmail search "subject:invoice"

# Search by sender
gog gmail search "from:someone@example.com"

# Complex search
gog gmail search "is:unread from:boss@company.com"

# Search with date range
gog gmail search "after:2026-01-01 before:2026-01-31"
```

### Send Emails

**Note:** gog uses a send command with different syntax than shown below. Use `gog gmail messages send --help` for details.


### Manage Labels

```bash
# List labels
kaya-cli gmail labels

# Add label to email
kaya-cli gmail label add --id MESSAGE_ID --label "Important"

# Remove label
kaya-cli gmail label remove --id MESSAGE_ID --label "Spam"
```

### Draft Emails

```bash
# Create draft
kaya-cli gmail draft create \
    --to "user@example.com" \
    --subject "Draft" \
    --body "Draft content"

# List drafts
kaya-cli gmail drafts

# Send draft
kaya-cli gmail draft send --id DRAFT_ID
```

## Output Formats

**JSON** (recommended for parsing):
```bash
# Inbox as JSON
kaya-cli gmail inbox --format json

# Parse with jq
kaya-cli gmail inbox --format json | jq -r '.[].subject'
```

**Plain text**:
```bash
kaya-cli gmail inbox
```

## Integration Examples

### Count unread emails
```bash
unread=$(kaya-cli gmail search "is:unread" --format json | jq 'length')
echo "You have $unread unread emails"
```

### Filter and archive
```bash
# Archive old read emails
kaya-cli gmail search "is:read older_than:30d" --format json | \
    jq -r '.[].id' | \
    xargs -I {} kaya-cli gmail archive --id {}
```

### Email notification
```bash
# Check for important emails
important=$(kaya-cli gmail search "is:unread label:important" --format json)
if [ "$(echo $important | jq 'length')" -gt 0 ]; then
    echo "You have important unread emails!"
    echo $important | jq -r '.[].subject'
fi
```

### Export emails
```bash
# Export subjects to file
kaya-cli gmail search "from:client@example.com" --format json | \
    jq -r '.[].subject' > client-emails.txt
```

## Error Handling

```bash
if ! kaya-cli gmail inbox --limit 1 &> /dev/null; then
    echo "Gmail access failed"
    echo "Check authentication: gog auth list"
    exit 1
fi
```

Common errors:
- **Authentication failed**: Re-run `gog auth add`
- **Quota exceeded**: Wait or increase quota
- **Invalid query**: Check Gmail search syntax

## Advanced Options

```bash
# Pagination
kaya-cli gmail inbox --limit 50 --offset 0

# Include spam and trash
kaya-cli gmail search "query" --include-spam --include-trash

# Download attachments
kaya-cli gmail get --id MESSAGE_ID --attachments ~/Downloads/

# Mark as read/unread
kaya-cli gmail mark read --id MESSAGE_ID
kaya-cli gmail mark unread --id MESSAGE_ID

# Move to trash
kaya-cli gmail trash --id MESSAGE_ID

# Permanent delete
kaya-cli gmail delete --id MESSAGE_ID
```

## Gmail Search Syntax

Common operators:
- `is:unread` - Unread emails
- `is:starred` - Starred emails
- `from:user@example.com` - From sender
- `to:user@example.com` - To recipient
- `subject:keyword` - Subject contains
- `has:attachment` - Has attachments
- `after:2026-01-01` - After date
- `before:2026-01-31` - Before date
- `older_than:7d` - Older than duration
- `newer_than:2d` - Newer than duration

Combine with AND/OR:
```bash
kaya-cli gmail search "from:boss@company.com is:unread"
kaya-cli gmail search "(from:client1@example.com OR from:client2@example.com) has:attachment"
```

## Performance

- List inbox: < 1s for 10-50 emails
- Search: < 2s for typical queries
- Send email: < 1s
- Token refresh: Automatic via keychain

## Batch Operations

```bash
# Batch label updates
kaya-cli gmail search "from:newsletter@example.com" --format json | \
    jq -r '.[].id' | \
    xargs -I {} kaya-cli gmail label add --id {} --label "Newsletters"

# Batch delete
kaya-cli gmail search "older_than:365d is:read" --format json | \
    jq -r '.[].id' | \
    xargs -I {} kaya-cli gmail trash --id {}
```

## Documentation

- Official docs: https://gogcli.sh/
- GitHub: https://github.com/steipete/gogcli
- Gmail search: https://support.google.com/mail/answer/7190
- Configuration: System keychain
