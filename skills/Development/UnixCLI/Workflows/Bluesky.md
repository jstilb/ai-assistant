# Bluesky Workflow (bsky)

Bluesky Social operations via bsky CLI.

## Prerequisites

- bsky CLI installed (`kaya-cli bluesky --version`)
- Bluesky account
- App password created
- Authentication configured

## Authentication

```bash
# Initial setup
bash ~/.claude/tools/UnixCLI/configure-bluesky.sh

# Or manual login
bsky login your-handle.bsky.social

# Session stored in ~/.config/bsky/
```

Create app password at: https://bsky.app/settings/app-passwords

## Common Operations

### View Timeline

```bash
# Recent timeline
bsky timeline

# Timeline as stream
bsky stream
```

### View Profile

```bash
# Your profile
bsky show-profile

# Another user's profile
bsky show-profile username.bsky.social
```

### Create Post

```bash
# Simple post
bsky post "Hello from CLI!"

# Post with hashtag
bsky post "Testing #bsky CLI"
```

### Search

```bash
# Search posts
bsky search "keyword"

# Search users
bsky search-actors "username"

# Search as JSON
kaya-cli bluesky search "query" --json
```

### Follow/Unfollow

```bash
# Follow user
kaya-cli bluesky follow username.bsky.social

# Unfollow user
kaya-cli bluesky unfollow username.bsky.social

# List following
kaya-cli bluesky following

# List followers
kaya-cli bluesky followers
```

## Output Formats

**JSON** (recommended for parsing):
```bash
# Timeline as JSON
kaya-cli bluesky timeline --json

# Parse with jq
kaya-cli bluesky timeline --json | jq -r '.feed[].post.record.text'
```

**Plain text**:
```bash
kaya-cli bluesky timeline
```

## Integration Examples

### Count posts
```bash
# Count posts in timeline
post_count=$(kaya-cli bluesky timeline --json | jq '.feed | length')
echo "Timeline has $post_count posts"
```

### Filter posts by keyword
```bash
# Find posts mentioning specific topic
kaya-cli bluesky timeline --json | \
    jq -r '.feed[].post.record.text' | \
    grep -i "keyword"
```

### Archive timeline
```bash
# Save timeline to file
timestamp=$(date +%Y%m%d)
kaya-cli bluesky timeline --limit 100 > ~/bluesky-archive-$timestamp.txt
```

### Scheduled posting
```bash
# In cron or scheduled task
echo "Daily update: $(date)" | kaya-cli bluesky post
```

## Error Handling

```bash
if ! kaya-cli bluesky profile show &> /dev/null; then
    echo "Bluesky authentication failed"
    echo "Re-login: bsky login your-handle.bsky.social"
    exit 1
fi
```

Common errors:
- **Authentication expired**: Re-run `bsky login`
- **Rate limiting**: Add delays between operations
- **Post not found**: Check post URI
- **User not found**: Verify handle

## Advanced Options

```bash
# Like a post
kaya-cli bluesky like POST_URI

# Repost
kaya-cli bluesky repost POST_URI

# Delete post
kaya-cli bluesky delete POST_URI

# Get notifications
kaya-cli bluesky notifications

# View specific user's feed
kaya-cli bluesky feed author username.bsky.social
```

## Use Cases

### Social Monitoring

```bash
# Monitor mentions
kaya-cli bluesky notifications --json | \
    jq '.[] | select(.reason == "mention")'

# Track hashtag
kaya-cli bluesky search "#topic" --json | \
    jq -r '.posts[].record.text'
```

### Content Publishing

```bash
# Publish blog post announcement
post_url="https://blog.example.com/post"
kaya-cli bluesky post "New post: $post_url"

# Thread creation
kaya-cli bluesky post "1/3 Thread about..."
# (Note: Threading support depends on CLI version)
```

### Analytics

```bash
# Follower count tracking
followers=$(kaya-cli bluesky profile show --json | jq '.followersCount')
echo "$(date): $followers followers" >> follower-history.txt

# Engagement tracking
kaya-cli bluesky profile show --stats --json | \
    jq '{followers, following, posts}'
```

### Automation

```bash
# Daily summary post
summary=$(kaya-cli calendar agenda | head -3)
kaya-cli bluesky post "Today's schedule:\n$summary"

# Cross-post to Bluesky
cat blog-post.md | head -280 | kaya-cli bluesky post
```

## Rate Limits

Bluesky API has rate limits:
- Timeline: ~100 requests/min
- Posts: ~30 creates/min
- Follows: ~20 operations/min

**Add delays in loops:**
```bash
for user in $(cat users.txt); do
    kaya-cli bluesky follow $user
    sleep 2  # Respect rate limits
done
```

## Performance

- Timeline fetch: < 1s
- Post creation: < 500ms
- Search: 1-2s
- Profile fetch: < 500ms

## Best Practices

1. **Use app passwords**: Never use main password
2. **Respect rate limits**: Add delays in automation
3. **Handle errors gracefully**: Check exit codes
4. **Archive important content**: Don't rely solely on platform
5. **Test before automation**: Verify commands work manually

## Pipe Composition

```bash
# Extract and process timeline
kaya-cli bluesky timeline --json | \
    jq -r '.feed[].post.record.text' | \
    grep -i "topic" | \
    sort | uniq

# Find users mentioning topic
kaya-cli bluesky search "AI" --json | \
    jq -r '.posts[].author.handle' | \
    sort | uniq
```

## Configuration

Session data: `~/.config/bsky/`

**Do not commit session files to version control.**

## Troubleshooting

### Session expired
```bash
# Re-login
bsky login your-handle.bsky.social
```

### Rate limited
```bash
# Add delays between requests
sleep 2
```

### Invalid credentials
```bash
# Create new app password
# Visit: https://bsky.app/settings/app-passwords
# Re-run login with new password
```

## Documentation

- Bluesky docs: https://docs.bsky.app/
- AT Protocol: https://atproto.com/
- bsky CLI: https://github.com/mattn/bsky
- API reference: https://docs.bsky.app/docs/api/
