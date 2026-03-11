# YouTube Workflow (yt-dlp)

Download videos, extract metadata, convert audio using yt-dlp CLI.

## Prerequisites

- yt-dlp installed (`kaya-cli youtube --version`)
- No authentication required for public videos
- Cookies needed for age-restricted/private content

## Common Operations

### Download Video

```bash
# Download best quality
kaya-cli youtube URL

# Download to specific location
kaya-cli youtube --output ~/Downloads/%(title)s.%(ext)s URL

# Download with custom format
kaya-cli youtube --format "bestvideo+bestaudio" URL
```

### Extract Metadata

```bash
# Get video metadata as JSON
kaya-cli youtube --dump-json --no-download URL

# Get specific fields
kaya-cli youtube --dump-json URL | jq '.title, .duration, .view_count'

# Get thumbnail URL
kaya-cli youtube --get-thumbnail URL
```

### Audio Extraction

```bash
# Extract as MP3
kaya-cli youtube --extract-audio --audio-format mp3 URL

# Extract with quality
kaya-cli youtube --extract-audio --audio-quality 0 URL
```

### Playlist Operations

```bash
# Download entire playlist
kaya-cli youtube --yes-playlist PLAYLIST_URL

# Get playlist metadata
kaya-cli youtube --flat-playlist --dump-json PLAYLIST_URL

# Extract all titles
kaya-cli youtube --flat-playlist --dump-json PLAYLIST_URL | jq -r '.title'
```

## Output Formats

**JSON** (recommended for parsing):
```bash
kaya-cli youtube --dump-json URL | jq
```

**Plain text**:
```bash
kaya-cli youtube --get-title URL
kaya-cli youtube --get-description URL
kaya-cli youtube --get-filename URL
```

## Integration Examples

### Check video before download
```bash
# Get duration and size before downloading
duration=$(kaya-cli youtube --dump-json URL | jq '.duration')
filesize=$(kaya-cli youtube --dump-json URL | jq '.filesize_approx')

if [ $duration -lt 600 ]; then
    echo "Video under 10 minutes, downloading..."
    kaya-cli youtube URL
fi
```

### Batch download with filtering
```bash
# Download only videos under 1GB
kaya-cli youtube --max-filesize 1G PLAYLIST_URL
```

### Extract and process
```bash
# Get video title and create folder
title=$(kaya-cli youtube --get-title URL)
mkdir "$title"
kaya-cli youtube --output "$title/%(title)s.%(ext)s" URL
```

## Error Handling

```bash
if ! kaya-cli youtube --dump-json URL &> /dev/null; then
    echo "Failed to fetch video metadata"
    exit 1
fi
```

Common errors:
- **Video unavailable**: Check URL, may be private/deleted
- **Rate limiting**: Add `--sleep-interval 5` flag
- **Format unavailable**: Try different `--format` option

## Advanced Options

```bash
# Limit download speed
kaya-cli youtube --limit-rate 1M URL

# Download with subtitles
kaya-cli youtube --write-sub --sub-lang en URL

# Download age-restricted (requires cookies)
kaya-cli youtube --cookies cookies.txt URL

# Resume interrupted download
kaya-cli youtube --continue URL
```

## Performance

- Metadata extraction: < 1s for most videos
- Download speed: Limited by network and server
- Parallel downloads: Use `--concurrent-fragments`

## Documentation

- Official docs: https://github.com/yt-dlp/yt-dlp
- Format selection: https://github.com/yt-dlp/yt-dlp#format-selection
- Output template: https://github.com/yt-dlp/yt-dlp#output-template
