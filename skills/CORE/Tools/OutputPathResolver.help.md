# OutputPathResolver

Generate standardized skill output paths following Kaya conventions.

## Usage

```bash
bun OutputPathResolver.ts --skill <name> --title <title> [options]
bun OutputPathResolver.ts -s <name> -t <title> [options]
```

## Options

| Flag | Short | Description |
|------|-------|-------------|
| `--skill` | `-s` | Skill name (TitleCase) |
| `--title` | `-t` | Output title (will be slug-ified) |
| `--type` | | Output type: memory (default), work, downloads, custom |
| `--custom-path` | | Custom base path (required for --type custom) |
| `--extension` | `-e` | File extension (default: md) |
| `--no-timestamp` | | Omit timestamp prefix from filename |
| `--create-dir` | `-c` | Create the output directory if it doesn't exist |
| `--json` | `-j` | Output as JSON with full path details |
| `--help` | `-h` | Show help |

## Output Types

| Type | Path Pattern | Use Case |
|------|--------------|----------|
| `memory` (default) | `MEMORY/[SkillName]/YYYY-MM-DD/` | Permanent skill outputs |
| `work` | `MEMORY/WORK/{session}/scratch/` | Work-session artifacts |
| `downloads` | `~/Downloads/` | User preview |
| `custom` | `<custom-path>/` | Special needs |

## Examples

### Generate memory path for research findings
```bash
bun OutputPathResolver.ts -s Research -t "ai-safety-findings"
# Output: ~/.claude/MEMORY/Research/2026-02-01/20260201-143052_ai-safety-findings.md
```

### Generate work artifact path (JSON format)
```bash
bun OutputPathResolver.ts -s Analysis -t "intermediate" --type work -e json
# Output: ~/.claude/MEMORY/WORK/{session}/scratch/20260201-143052_intermediate.json
```

### Generate downloads path without timestamp
```bash
bun OutputPathResolver.ts -s Report -t "summary" --type downloads --no-timestamp
# Output: ~/Downloads/summary.md
```

### Create directory and get JSON output
```bash
bun OutputPathResolver.ts -s Research -t "output" -c -j
# Output:
# {
#   "path": "/Users/.../.claude/MEMORY/Research/2026-02-01/20260201-143052_output.md",
#   "directory": "/Users/.../.claude/MEMORY/Research/2026-02-01",
#   "filename": "20260201-143052_output.md",
#   "directoryExisted": false
# }
```

### Use with custom path
```bash
bun OutputPathResolver.ts -s Export -t "report" --type custom --custom-path ~/Documents/exports
# Output: ~/Documents/exports/20260201-143052_report.md
```

## Programmatic Usage

```typescript
import { resolveOutputPath, ensureOutputDir, prepareOutputPath } from '~/.claude/skills/CORE/Tools/OutputPathResolver';

// Basic usage - memory output (default)
const resolved = await resolveOutputPath({
  skill: 'Research',
  title: 'findings-summary'
});
console.log(resolved.path);
// ~/.claude/MEMORY/Research/2026-02-01/20260201-143052_findings-summary.md

// Ensure directory exists
ensureOutputDir(resolved.path);

// Or use convenience function that does both
const ready = await prepareOutputPath({
  skill: 'Research',
  title: 'analysis-results',
  extension: 'json'
});
await Bun.write(ready.path, JSON.stringify(data));
```

## Options Interface

```typescript
interface OutputPathOptions {
  skill: string;           // Skill name (TitleCase)
  title: string;           // Output title (slug-ified)
  type?: 'memory' | 'work' | 'downloads' | 'custom';
  customPath?: string;     // For type: 'custom'
  extension?: string;      // Default: 'md'
  includeTimestamp?: boolean; // Default: true
  workSessionId?: string;  // Auto-detected for type: 'work'
}
```

## Path Conventions

### Filename Format
```
{timestamp}_{slug}.{extension}
```
- **timestamp**: `YYYYMMDD-HHMMSS` (can be disabled with `--no-timestamp`)
- **slug**: Lowercase, hyphenated version of title (max 64 chars)
- **extension**: File extension (default: md)

### Directory Structure
```
~/.claude/
├── MEMORY/
│   ├── Research/                    # Skill name
│   │   ├── 2026-02-01/             # Date-based organization
│   │   │   ├── 20260201-143052_findings.md
│   │   │   └── 20260201-150823_analysis.json
│   │   └── 2026-02-02/
│   │       └── ...
│   └── WORK/
│       └── 20260201-143052_project-x/
│           └── scratch/             # Work artifacts
│               └── 20260201-144512_intermediate.json
```

## Integration with Skills

Skills that produce output files should use OutputPathResolver in their workflows:

```typescript
// In skill workflow or tool
import { prepareOutputPath } from '~/.claude/skills/CORE/Tools/OutputPathResolver';

const { path } = await prepareOutputPath({
  skill: 'MySkill',
  title: 'output-file'
});

// Write your output
await Bun.write(path, content);
```

This ensures consistent output organization across all Kaya skills.
