# Drive Workflow (rclone)

Google Drive sync and operations via rclone CLI.

## Prerequisites

- rclone installed (`kaya-cli drive version`)
- OAuth2 authentication configured
- Remote named "gdrive" configured

## Authentication

```bash
# Initial setup
bash ~/.claude/tools/UnixCLI/configure-google-auth.sh

# Test connection
kaya-cli drive lsd gdrive:
```

## Common Operations

### List Files and Directories

```bash
# List directories in root
kaya-cli drive lsd gdrive:

# List files in directory
kaya-cli drive lsf gdrive:Documents/

# List recursively
kaya-cli drive lsf gdrive: --recursive

# List with details
kaya-cli drive lsl gdrive:Documents/
```

### Copy Files

```bash
# Upload file to Drive
kaya-cli drive copy ~/local/file.txt gdrive:Documents/

# Download file from Drive
kaya-cli drive copy gdrive:Documents/file.txt ~/local/

# Upload directory
kaya-cli drive copy ~/local/folder/ gdrive:Backup/folder/
```

### Sync Directories

```bash
# Sync local to Drive (one-way)
kaya-cli drive sync ~/Documents gdrive:Backup/Documents

# Sync Drive to local
kaya-cli drive sync gdrive:Documents ~/local/Documents

# Bidirectional sync
kaya-cli drive bisync ~/Documents gdrive:Backup/Documents
```

### Delete Files

```bash
# Delete file
kaya-cli drive delete gdrive:Documents/old-file.txt

# Delete directory
kaya-cli drive purge gdrive:OldFolder/

# Delete with confirmation
kaya-cli drive delete --interactive gdrive:file.txt
```

### Drive Information

```bash
# Show quota and usage
kaya-cli drive about gdrive:

# Get file info
kaya-cli drive lsl gdrive:file.txt
```

## Output Formats

**JSON** (recommended for parsing):
```bash
# List as JSON
kaya-cli drive lsf gdrive: --format json

# Drive info as JSON
kaya-cli drive about gdrive: --json
```

**Plain text**:
```bash
kaya-cli drive lsf gdrive:
```

## Integration Examples

### Backup script
```bash
# Daily backup to Drive
timestamp=$(date +%Y%m%d)
kaya-cli drive sync ~/important-data gdrive:Backups/daily-$timestamp/

# Verify backup
kaya-cli drive lsd gdrive:Backups/ | grep $timestamp
```

### Find large files
```bash
# Files over 100MB
kaya-cli drive lsl gdrive: --recursive | \
    awk '$1 > 104857600 {print $0}'
```

### Calculate directory size
```bash
# Get total size
kaya-cli drive size gdrive:Documents --json | jq '.bytes'
```

### Filter by file type
```bash
# List only PDFs
kaya-cli drive lsf gdrive:Documents --include "*.pdf"

# Exclude temp files
kaya-cli drive lsf gdrive: --exclude "*.tmp"
```

## Error Handling

```bash
if ! kaya-cli drive lsd gdrive: &> /dev/null; then
    echo "Drive connection failed"
    echo "Reconfigure: kaya-cli drive config"
    exit 1
fi
```

Common errors:
- **Authentication expired**: Re-run `rclone config reconnect gdrive:`
- **Quota exceeded**: Check `kaya-cli drive about gdrive:`
- **Rate limiting**: Use `--tpslimit` flag

## Advanced Options

```bash
# Dry run (preview operations)
kaya-cli drive sync ~/folder gdrive:folder --dry-run

# Transfer with progress
kaya-cli drive copy file.zip gdrive: --progress

# Limit bandwidth
kaya-cli drive copy large-file.zip gdrive: --bwlimit 1M

# Parallel transfers
kaya-cli drive sync ~/folder gdrive:folder --transfers 8

# Exclude patterns
kaya-cli drive sync ~/folder gdrive:folder \
    --exclude "*.tmp" \
    --exclude ".git/**"
```

## Performance

- List operations: < 1s for hundreds of files
- Small file transfers: Network-limited
- Large file transfers: Chunked with resume support
- Sync operations: Checksums for change detection

## Common Use Cases

### Automated Backups

```bash
# Incremental backup
kaya-cli drive sync ~/Documents gdrive:Backups/Documents \
    --exclude ".DS_Store" \
    --exclude "*.tmp"
```

### Archive Old Files

```bash
# Move files older than 90 days to archive
find ~/Documents -mtime +90 -type f | while read file; do
    kaya-cli drive copy "$file" gdrive:Archive/
done
```

### Shared Folder Sync

```bash
# Sync shared folder locally
kaya-cli drive sync gdrive:"Shared with me/Project" ~/Projects/Shared
```

## Documentation

- Official docs: https://rclone.org/
- Google Drive: https://rclone.org/drive/
- Commands: https://rclone.org/commands/
- Configuration: `~/.config/rclone/rclone.conf`
