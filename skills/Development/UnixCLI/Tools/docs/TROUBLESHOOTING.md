# Troubleshooting Guide - Kaya Unix CLI Tools

Common issues and solutions for Unix CLI tools integration.

## Table of Contents

1. [Installation Issues](#installation-issues)
2. [Authentication Issues](#authentication-issues)
3. [Runtime Issues](#runtime-issues)
4. [Tool-Specific Problems](#tool-specific-problems)
5. [PATH Issues](#path-issues)
6. [Network Issues](#network-issues)
7. [Performance Issues](#performance-issues)

---

## Installation Issues

### Tool not found after installation

**Symptoms:**
```bash
$ kaya-cli youtube --help
bash: youtube: command not found
```

**Solutions:**

1. **Verify installation:**
   ```bash
   bash ~/.claude/tools/UnixCLI/validate-installations.sh
   ```

2. **Check Homebrew install:**
   ```bash
   brew list | grep -E "yt-dlp|gcalcli|rclone|gogcli|gemini"
   ```

3. **Re-run installation:**
   ```bash
   bash ~/.claude/tools/UnixCLI/install-cli-tools.sh
   ```

### bsky not found in PATH

**Symptoms:**
```bash
$ bsky --version
bash: bsky: command not found
```

**Cause:** Go binaries installed to `~/go/bin` which isn't in PATH

**Solution:**

1. **Check if bsky exists:**
   ```bash
   ls -la ~/go/bin/bsky
   ```

2. **Add to PATH temporarily:**
   ```bash
   export PATH="$PATH:$HOME/go/bin"
   ```

3. **Add to PATH permanently:**
   ```bash
   echo 'export PATH="$PATH:$HOME/go/bin"' >> ~/.zshrc
   source ~/.zshrc
   ```

4. **Verify:**
   ```bash
   which bsky
   bsky --version
   ```

### Homebrew tap not found

**Symptoms:**
```bash
Error: No available formula with the name "steipete/tap/gogcli"
```

**Solution:**

1. **Add tap manually:**
   ```bash
   brew tap steipete/tap
   ```

2. **Install gog:**
   ```bash
   brew install steipete/tap/gogcli
   ```

### Go not installed

**Symptoms:**
```bash
bash: go: command not found
```

**Solution:**

1. **Install Go via Homebrew:**
   ```bash
   brew install go
   ```

2. **Verify installation:**
   ```bash
   go version
   ```

---

## Authentication Issues

### OAuth2 token expired

**Symptoms:**
- "Invalid credentials" error
- "Token expired" message
- Operations fail after previously working

**Solutions by tool:**

#### gcalcli
```bash
# Re-authenticate (will open browser)
gcalcli list

# Or reconfigure
bash ~/.claude/tools/UnixCLI/configure-google-auth.sh
```

#### rclone
```bash
# Reconnect
rclone config reconnect gdrive:

# Or reconfigure
bash ~/.claude/tools/UnixCLI/configure-google-auth.sh
```

#### gog
```bash
# Re-add account
gog auth add

# List accounts
gog auth list
```

### Bluesky authentication failed

**Symptoms:**
- "Login failed" error
- "Invalid credentials"

**Solutions:**

1. **Verify you're using app password (not main password):**
   - Go to: https://bsky.app/settings/app-passwords
   - Create new app password
   - Use that password (not your main account password)

2. **Re-login:**
   ```bash
   bsky login your-handle.bsky.social
   ```

3. **Check session file:**
   ```bash
   ls -la ~/.config/bsky/
   ```

### Missing OAuth2 credentials

**Symptoms:**
- "No client_secret.json" error
- "Credentials not found"

**Solution:**

1. **Create OAuth2 credentials in Google Cloud Console:**
   - Visit: https://console.cloud.google.com/apis/credentials
   - Create OAuth 2.0 Client ID
   - Application type: Desktop app
   - Download JSON file

2. **Enable required APIs:**
   - Calendar API
   - Drive API
   - Gmail API

3. **Run configuration script:**
   ```bash
   bash ~/.claude/tools/UnixCLI/configure-google-auth.sh
   ```

### Gemini API key not set

**Symptoms:**
- "API key required" error
- "Authentication failed"

**Solution:**

1. **Get API key:**
   - Visit: https://makersuite.google.com/app/apikey

2. **Set environment variable:**
   ```bash
   export GEMINI_API_KEY="your-api-key"
   ```

3. **Add to ~/.zshrc:**
   ```bash
   echo 'export GEMINI_API_KEY="your-api-key"' >> ~/.zshrc
   source ~/.zshrc
   ```

4. **Or store in secrets.json (recommended):**
   ```json
   {
     "GEMINI_API_KEY": "your-api-key"
   }
   ```

---

## Runtime Issues

### Rate limiting

**Symptoms:**
- "Too many requests" error
- "Rate limit exceeded"
- Operations slow down or fail

**Solutions:**

1. **Add delays in loops:**
   ```bash
   for item in $(cat list.txt); do
       kaya-cli service operation $item
       sleep 2  # Wait 2 seconds between operations
   done
   ```

2. **Reduce request frequency:**
   - Batch operations
   - Cache results
   - Increase sleep intervals

3. **Check quotas:**
   ```bash
   # Gmail quota
   gog gmail quota

   # Drive quota
   kaya-cli drive about gdrive:
   ```

### Network timeouts

**Symptoms:**
- Operations hang
- "Connection timeout" errors
- Slow responses

**Solutions:**

1. **Check internet connection:**
   ```bash
   ping -c 3 google.com
   ```

2. **Verify service status:**
   - YouTube: https://www.youtube.com/
   - Google Workspace: https://www.google.com/appsstatus
   - Bluesky: https://bsky.app/

3. **Increase timeout:**
   ```bash
   # For rclone
   kaya-cli drive lsd gdrive: --timeout 60s

   # For yt-dlp
   kaya-cli youtube URL --socket-timeout 60
   ```

### Quota exceeded

**Symptoms:**
- "Quota exceeded" error
- "Storage full" for Drive
- "Too many emails" for Gmail

**Solutions:**

1. **Check Drive storage:**
   ```bash
   kaya-cli drive about gdrive: --json | jq '.total, .used, .free'
   ```

2. **Clean up old files:**
   ```bash
   # Find large files
   kaya-cli drive lsl gdrive: --recursive | sort -n -k1 | tail -20
   ```

3. **Wait for quota reset:**
   - Most quotas reset daily
   - Check service documentation for specifics

---

## Tool-Specific Problems

### YouTube (yt-dlp)

#### Video unavailable

**Solution:**
- Verify URL is correct
- Check if video is private/deleted
- Try with `--cookies cookies.txt` for age-restricted content

#### Format not available

**Solution:**
```bash
# List available formats
kaya-cli youtube -F URL

# Choose specific format
kaya-cli youtube -f 137+140 URL
```

### Calendar (gcalcli)

#### Calendar not found

**Solution:**
```bash
# List all calendars
kaya-cli calendar list

# Use specific calendar
kaya-cli calendar --calendar "Calendar Name" agenda
```

#### Event creation fails

**Solution:**
- Check date format: "2026-02-01 10:00"
- Verify calendar has write permissions
- Try simpler event first: `kaya-cli calendar add "Test event"`

### Drive (rclone)

#### gdrive remote not configured

**Symptoms:**
```
Failed to create file system for "gdrive:": didn't find section in config file
```

**Solution:**
```bash
# Configure rclone
rclone config

# When prompted:
# - Name: gdrive
# - Storage: drive (Google Drive)
# - Scope: 1 (full access)
# - Use auto config: y
```

#### Sync conflicts

**Solution:**
```bash
# Dry run first
kaya-cli drive sync ~/folder gdrive:folder --dry-run

# Check differences
kaya-cli drive check ~/folder gdrive:folder

# Force sync
kaya-cli drive sync ~/folder gdrive:folder --force
```

### Gmail (gog)

#### Search returns no results

**Solution:**
- Verify search syntax: https://support.google.com/mail/answer/7190
- Check if account has emails
- Try simpler query: `kaya-cli gmail inbox --limit 5`

#### Send email fails

**Solution:**
- Verify recipient email is valid
- Check for required fields (to, subject, body)
- Test with simple email first

### Gemini (gemini-cli)

#### Response truncated

**Solution:**
```bash
# Increase max tokens
kaya-cli gemini --max-tokens 1000 "your query"
```

#### Invalid JSON response

**Solution:**
- Simplify query
- Request specific format in prompt
- Check if API is working: `kaya-cli gemini "test"`

### Bluesky (bsky)

#### Timeline empty

**Solution:**
- Verify account has following
- Check if authenticated: `kaya-cli bluesky profile show`
- Try with limit: `kaya-cli bluesky timeline --limit 20`

#### Post fails

**Solution:**
- Check character limit (300 characters)
- Verify authentication
- Try simple post: `kaya-cli bluesky post "test"`

---

## PATH Issues

### kaya-cli not found

**Symptoms:**
```bash
$ kaya-cli --help
bash: kaya-cli: command not found
```

**Solution:**

1. **Check if kaya-cli exists:**
   ```bash
   ls -la ~/.claude/bin/kaya-cli
   ```

2. **Verify it's executable:**
   ```bash
   chmod +x ~/.claude/bin/kaya-cli
   ```

3. **Check PATH:**
   ```bash
   echo $PATH | grep -o "[^:]*" | grep claude
   ```

4. **Add to PATH if missing:**
   ```bash
   echo 'export PATH="$PATH:$HOME/.claude/bin"' >> ~/.zshrc
   source ~/.zshrc
   ```

### Multiple versions of tool

**Symptoms:**
- Unexpected behavior
- Wrong version executing

**Solution:**

1. **Check which version is used:**
   ```bash
   which yt-dlp
   type -a yt-dlp
   ```

2. **Use full path:**
   ```bash
   /opt/homebrew/bin/yt-dlp --version
   ```

3. **Remove duplicates:**
   ```bash
   # If installed via pip and Homebrew
   pip3 uninstall yt-dlp  # Remove pip version
   ```

---

## Network Issues

### Proxy configuration

**If behind a proxy:**

1. **Set environment variables:**
   ```bash
   export HTTP_PROXY="http://proxy.example.com:8080"
   export HTTPS_PROXY="http://proxy.example.com:8080"
   ```

2. **Configure rclone:**
   ```bash
   rclone config
   # Edit existing remote → Advanced config → HTTP proxy
   ```

### SSL certificate errors

**Solution:**

1. **Update system certificates:**
   ```bash
   brew upgrade ca-certificates
   ```

2. **For specific tools:**
   ```bash
   # rclone
   kaya-cli drive lsd gdrive: --ca-cert /path/to/cert.pem
   ```

---

## Performance Issues

### Slow operations

**Solutions:**

1. **Use parallel transfers (rclone):**
   ```bash
   kaya-cli drive sync ~/folder gdrive:folder --transfers 8
   ```

2. **Limit bandwidth if needed:**
   ```bash
   kaya-cli drive copy file.zip gdrive: --bwlimit 1M
   ```

3. **Cache authentication:**
   - Tokens are cached automatically
   - Don't re-authenticate unnecessarily

### Memory issues

**For large operations:**

```bash
# Process in chunks
# Instead of:
kaya-cli youtube --yes-playlist HUGE_PLAYLIST

# Do:
kaya-cli youtube --playlist-start 1 --playlist-end 10 PLAYLIST
kaya-cli youtube --playlist-start 11 --playlist-end 20 PLAYLIST
```

---

## Debugging

### Enable verbose output

Most tools support verbose mode:

```bash
# yt-dlp
kaya-cli youtube --verbose URL

# rclone
kaya-cli drive lsd gdrive: -v

# gog
gog --debug gmail inbox
```

### Check logs

```bash
# Installation logs
tail -f ~/.claude/logs/unix-cli-install-*.log

# Tool-specific logs
# (varies by tool, check tool documentation)
```

### Test authentication

```bash
# Quick auth test for all services
gcalcli list
rclone lsd gdrive:
gog gmail inbox --limit 1
bsky profile show
kaya-cli youtube --version  # No auth needed
```

---

## Getting Help

### Documentation

- **Tool docs:** `kaya-cli <service> --help`
- **Skill docs:** `~/.claude/skills/Development/UnixCLI/SKILL.md`
- **Workflows:** `~/.claude/skills/Development/UnixCLI/Workflows/`
- **Architecture:** `~/.claude/MEMORY/LEARNING/ARCHITECTURE/2026-01-28_unix-cli-integration.md`

### Validation

```bash
# Run full validation
bash ~/.claude/tools/UnixCLI/validate-installations.sh

# Run specific tests
bash ~/.claude/tools/UnixCLI/tests/test-individual-tools.sh
bash ~/.claude/tools/UnixCLI/tests/test-kaya-cli-routing.sh
```

### Reset and reinstall

**If all else fails:**

```bash
# 1. Remove tools
brew uninstall yt-dlp gcalcli rclone gogcli gemini
rm ~/go/bin/bsky

# 2. Clean config
rm -rf ~/.local/share/gcalcli
rm -rf ~/.config/rclone
rm -rf ~/.config/bsky

# 3. Reinstall
bash ~/.claude/tools/UnixCLI/install-cli-tools.sh

# 4. Reconfigure
bash ~/.claude/tools/UnixCLI/configure-google-auth.sh
bash ~/.claude/tools/UnixCLI/configure-bluesky.sh

# 5. Validate
bash ~/.claude/tools/UnixCLI/validate-installations.sh
```

---

## Still Having Issues?

1. **Check tool-specific documentation:**
   - yt-dlp: https://github.com/yt-dlp/yt-dlp
   - gcalcli: https://github.com/insanum/gcalcli
   - rclone: https://rclone.org/
   - gog: https://gogcli.sh/
   - bsky: https://github.com/mattn/bsky

2. **Search tool issue trackers:**
   - Most tools have GitHub issues
   - Search for similar problems

3. **Check service status:**
   - Google Workspace: https://www.google.com/appsstatus
   - Bluesky: https://bsky.app/

---

**Version:** 1.0.0
**Last Updated:** 2026-01-28
