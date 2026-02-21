# Changelog - Kaya Unix CLI Tools

All notable changes to the Unix CLI tools integration will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [1.0.0] - 2026-01-28

### Added

#### CLI Tools
- **yt-dlp (2025.12.08)** - YouTube video downloads and metadata extraction
- **gcalcli (4.5.1)** - Google Calendar management
- **rclone (1.72.1)** - Google Drive sync and operations
- **gogcli/gog (0.9.0)** - Gmail and Google Workspace operations
- **gemini-cli (0.25.1)** - Gemini AI queries and generation
- **bsky (0.0.74)** - Bluesky social media operations
- Integration with existing **Browse.ts** for Playwright operations

#### Wrapper
- **kaya-cli (1.0.0)** - Unified CLI wrapper with service routing
- Help system (`--help`)
- Version info (`--version`)
- Setup wizard (`setup`)
- Error handling for unknown services
- 8 service routes (youtube, calendar, drive, gmail, gemini, asana, playwright, bluesky)
- Service aliases (yt, gcal, ai, pw, bsky)

#### Installation
- **install-cli-tools.sh** - Automated installation script
  - Homebrew integration
  - Go package installation
  - PATH verification
  - Logging to `~/.claude/logs/`
  - Validation checks

#### Configuration
- **configure-google-auth.sh** - Google OAuth2 setup
  - Interactive browser-based flow
  - Support for gcalcli, rclone, gog
  - Token storage configuration
  - Authentication testing

- **configure-bluesky.sh** - Bluesky authentication setup
  - App password guidance
  - Session token storage
  - Connection testing

- **validate-installations.sh** - Comprehensive validation
  - Installation checks
  - Version verification
  - Authentication testing
  - Colorized output
  - Pass/Fail/Warn reporting

#### Documentation
- **UnixCLI Skill** (`skills/UnixCLI/SKILL.md`)
  - Philosophy and quick start
  - Available tools table
  - Workflow routing
  - Pipe composition examples
  - Authentication guides
  - Kaya integration patterns
  - Output formats
  - Error handling
  - Troubleshooting

- **Workflow Files** (7 total)
  - `Workflows/YouTube.md` - yt-dlp operations
  - `Workflows/Calendar.md` - gcalcli operations
  - `Workflows/Drive.md` - rclone operations
  - `Workflows/Gmail.md` - gog operations
  - `Workflows/Gemini.md` - gemini-cli operations
  - `Workflows/Asana.md` - Custom tools operations
  - `Workflows/Bluesky.md` - bsky operations

- **README.md** - Installation and usage guide
- **TROUBLESHOOTING.md** - Comprehensive troubleshooting guide
- **Architecture Documentation** - System design and decisions

#### Testing
- **test-individual-tools.sh** - Unit tests for each CLI tool
- **test-kaya-cli-routing.sh** - Integration tests for routing
- **test-e2e-operations.sh** - End-to-end tests with real operations
- **test-pipe-composition.sh** - Unix pipe composition tests

#### PATH Updates
- Automatic Go binary path addition to `~/.zshrc`
- PATH verification in installation script

### Integration Points

#### Kaya Skills
- Browser skill updated with CLI alternative documentation
- System skill prepared for CLIToolsCheck workflow

#### Authentication
- OAuth2 token storage for Google services
- System keychain integration (gog)
- Session-based auth (Bluesky)
- Environment variable support (Gemini)
- secrets.json support for API keys

#### Features
- Full pipe composition support (jq, awk, grep)
- JSON output for all services
- TSV output for calendar
- Command substitution
- Output redirection
- Multi-stage pipe operations
- Batch operations support

### Technical Details

#### Tool Versions Installed
```
yt-dlp:      2025.12.08
gcalcli:     4.5.1
rclone:      1.72.1
gog:         0.9.0 (99d9575)
gemini-cli:  0.25.1
bsky:        0.0.74
bun:         1.3.5 (for TypeScript tools)
```

#### Token Storage Locations
```
gcalcli:  ~/.local/share/gcalcli/oauth/
rclone:   ~/.config/rclone/rclone.conf
gog:      System keychain
bsky:     ~/.config/bsky/
gemini:   Environment or secrets.json
```

#### File Structure Created
```
~/.claude/bin/kaya-cli
~/.claude/tools/UnixCLI/
  install-cli-tools.sh
  configure-google-auth.sh
  configure-bluesky.sh
  validate-installations.sh
  README.md
  CHANGELOG.md
  docs/
    TROUBLESHOOTING.md
  tests/
    test-individual-tools.sh
    test-kaya-cli-routing.sh
    test-e2e-operations.sh
    test-pipe-composition.sh

~/.claude/skills/UnixCLI/
  SKILL.md
  Workflows/
    YouTube.md
    Calendar.md
    Drive.md
    Gmail.md
    Gemini.md
    Asana.md
    Bluesky.md

~/.claude/MEMORY/LEARNING/ARCHITECTURE/
  2026-01-28_unix-cli-integration.md
```

### Known Limitations

1. **gogcli** - Some advanced Gmail operations may require custom implementation
2. **bsky** - Requires manual PATH update for Go binaries
3. **OAuth2 setup** - Multi-step process requiring browser interaction
4. **Asana** - Limited to existing custom tools, full CLI in v2.0
5. **Rate limits** - Service-specific quotas apply
6. **Network dependency** - Most operations require internet connection

### Dependencies

- **Homebrew** - macOS package manager
- **Go** - Required for bsky installation
- **Bun** - Required for TypeScript tools
- **jq** - Optional but recommended for JSON parsing
- **Browser** - Required for OAuth2 flows

### Security

- OAuth2 tokens stored locally with restricted permissions
- gog uses system keychain for enhanced security
- No credentials in version control
- API keys stored in gitignored secrets.json
- All authentication uses HTTPS
- Tokens auto-refresh when expired

---

## [Unreleased] - Future Enhancements

### Planned for v2.0

- Full Asana CLI implementation (create, update, delete tasks)
- Additional services (Notion, Slack, Linear, Discord)
- Unified configuration file
- Interactive mode (REPL)
- Enhanced error messages
- Response caching
- Parallel request support
- Tab completion for zsh/bash
- Cross-service workflows
- Health check automation

---

## Version History

- **1.0.0** (2026-01-28) - Initial release
  - 7 CLI tools integrated
  - Unified wrapper
  - Complete documentation
  - Test suite
  - OAuth2 configuration

---

**Maintenance:** This file is updated with each release
**Format:** Based on Keep a Changelog 1.0.0
**Versioning:** Semantic Versioning 2.0.0
