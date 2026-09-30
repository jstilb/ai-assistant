# Obsidian CLI Workflow

CLI tool for Obsidian vault operations via terminal.

## Installation

```bash
brew tap yakitrak/yakitrak
brew install yakitrak/yakitrak/obsidian-cli
```

**Alias:** `obs` (configured in ~/.zshrc)

## Configuration

Set default vault (auto-detects from Obsidian app config):
```bash
obsidian-cli set-default obsidian
obsidian-cli print-default
```

**Current Default:** `/Users/[user]/Desktop/obsidian`

## Commands

### Search & Open

```bash
# Fuzzy search by filename
obs search "meeting notes"

# Search note content
obs search-content "machine learning"

# Open specific note
obs open "My Note"

# Open in editor instead of Obsidian app
obs search "note" --editor
```

### Create & Edit

```bash
# Create new note
obs create "New Note"

# Create with content
obs create "New Note" --content "Initial content here"

# Create in subfolder
obs create "folder/New Note"

# Open daily note (creates if doesn't exist)
obs daily
```

### Move & Delete

```bash
# Move/rename note (auto-updates backlinks)
obs move "Old Name" "New Name"

# Move to different folder
obs move "Note" "Archive/Note"

# Delete note
obs delete "Note to remove"
```

### View Content

```bash
# Print note contents to terminal
obs print "My Note"

# View/modify frontmatter
obs frontmatter "My Note"
obs frontmatter "My Note" --set "tags=work,project"
```

### Vault Flag

Override default vault for any command:
```bash
obs search "query" --vault "other-vault"
```

## Pipe Operations

```bash
# Search and pipe to fzf
obs search-content "topic" | fzf

# Print note and pipe to other tools
obs print "Research Note" | fabric -p extract_wisdom

# Create note from stdin
echo "Quick capture" | obs create "Inbox/Quick Note" --content -
```

## Source

- GitHub: https://github.com/Yakitrak/obsidian-cli
- Written in Go, cross-platform
