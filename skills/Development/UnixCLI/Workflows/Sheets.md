# Google Sheets CLI Workflow

Unix-style interface for Google Sheets operations with 26 commands across 4 phases.

## Quick Reference

```bash
# Essential Operations
kaya-cli sheets list                              # List recent spreadsheets
kaya-cli sheets create "Budget 2026"              # Create new spreadsheet
kaya-cli sheets read <id> [range]                 # Read data
kaya-cli sheets write <id> <range> '<json>'       # Write data
kaya-cli sheets append <id> '<json>'              # Append rows
kaya-cli sheets clear <id> <range>                # Clear range
kaya-cli sheets delete-rows <id> <sheet> 5:10     # Delete rows
cat data.csv | kaya-cli sheets import <id>        # Import CSV
kaya-cli sheets export <id> --csv > out.csv       # Export CSV
kaya-cli sheets info <id>                         # Get metadata

# Sheet/Tab Management
kaya-cli sheets add-sheet <id> "New Tab"          # Create tab
kaya-cli sheets delete-sheet <id> "Old Tab"       # Delete tab
kaya-cli sheets rename-sheet <id> "Old" "New"     # Rename tab
kaya-cli sheets copy-sheet <id> "Tab" --to <dest> # Copy tab
kaya-cli sheets duplicate <id> "Copy Name"        # Clone spreadsheet

# Data Intelligence
kaya-cli sheets find <id> "search term"           # Search values
kaya-cli sheets sort <id> <range> --by=B --desc   # Sort by column
kaya-cli sheets filter <id> <range> --col=B --gt=100  # Filter rows
kaya-cli sheets formula <id> "E2" "=SUM(A2:D2)"   # Set formula
kaya-cli sheets named-ranges <id> list            # Manage named ranges

# Formatting & Sharing
kaya-cli sheets format <id> <range> --bold --bg=#4285F4
kaya-cli sheets freeze <id> "Sheet1" --rows=1
kaya-cli sheets share <id> user@example.com --role=editor
kaya-cli sheets permissions <id>
kaya-cli sheets protect <id> <range>
```

---

## Phase 1: Essential Data Operations

### list
List recent spreadsheets from Google Drive.

```bash
kaya-cli sheets list                  # Default: 10 results
kaya-cli sheets list --limit 20       # Custom limit
kaya-cli sheets list --json           # JSON output for piping
kaya-cli sheets list --tsv            # TSV output
```

### create
Create a new spreadsheet.

```bash
kaya-cli sheets create "My Spreadsheet"
kaya-cli sheets create "Budget 2026" --json    # Returns ID, title, URL
```

### read
Read data from a spreadsheet.

```bash
kaya-cli sheets read 1abc123                    # Read entire first sheet
kaya-cli sheets read 1abc123 "Sheet1"           # Read specific sheet
kaya-cli sheets read 1abc123 "Sheet1!A1:D10"    # Read specific range
kaya-cli sheets read 1abc123 "A:A" --json       # Column A as JSON
kaya-cli sheets read 1abc123 --tsv              # TSV output
```

### write
Write data to a specific range (overwrites existing).

```bash
# Single cell
kaya-cli sheets write 1abc123 "A1" '[["value"]]'

# Multiple cells
kaya-cli sheets write 1abc123 "A1:B2" '[["a","b"],["c","d"]]'

# With header row
kaya-cli sheets write 1abc123 "A1:C2" '[["Name","Age","City"],["John",30,"NYC"]]'
```

### append
Append rows to the end of a sheet.

```bash
# Single row
kaya-cli sheets append 1abc123 '[["new","row"]]'

# Multiple rows
kaya-cli sheets append 1abc123 '[["row1col1","row1col2"],["row2col1","row2col2"]]'
```

### clear
Clear a range without deleting the cells.

```bash
kaya-cli sheets clear 1abc123 "A1:D10"
kaya-cli sheets clear 1abc123 "Sheet1!A1:Z100" --json
```

### delete-rows
Delete specific rows from a sheet.

```bash
kaya-cli sheets delete-rows 1abc123 Sheet1 5:10      # Delete rows 5-10
kaya-cli sheets delete-rows 1abc123 "Data" 1:1       # Delete row 1
```

### import
Import CSV/TSV data from stdin.

```bash
cat data.csv | kaya-cli sheets import 1abc123
cat data.tsv | kaya-cli sheets import 1abc123 --tsv
cat data.csv | kaya-cli sheets import 1abc123 "Sheet2"   # Specific sheet
```

### export
Export sheet data to CSV/TSV.

```bash
kaya-cli sheets export 1abc123 --csv > out.csv
kaya-cli sheets export 1abc123 --tsv > out.tsv
kaya-cli sheets export 1abc123 "Sheet1!A1:D10" --csv
```

### batch
Execute multiple operations in one call.

```bash
# Single operation
kaya-cli sheets batch 1abc123 '[{"op":"write","range":"A1","values":[["x"]]}]'

# Multiple operations
kaya-cli sheets batch 1abc123 '[
  {"op":"write","range":"A1","values":[["Header"]]},
  {"op":"append","values":[["Row 1"],["Row 2"]]},
  {"op":"clear","range":"B1:B10"}
]'
```

**Batch operations:**
- `write` - requires `range` and `values`
- `append` - requires `values`, optional `sheet`
- `clear` - requires `range`

### info
Get spreadsheet metadata.

```bash
kaya-cli sheets info 1abc123           # Human-readable
kaya-cli sheets info 1abc123 --json    # JSON for parsing
```

---

## Phase 2: Sheet/Tab Management

### add-sheet
Create a new sheet/tab in the spreadsheet.

```bash
kaya-cli sheets add-sheet 1abc123 "New Tab"
kaya-cli sheets add-sheet 1abc123 "Q1 Data" --json
```

### delete-sheet
Delete a sheet/tab from the spreadsheet.

```bash
kaya-cli sheets delete-sheet 1abc123 "Old Tab"
```

### rename-sheet
Rename a sheet/tab.

```bash
kaya-cli sheets rename-sheet 1abc123 "Sheet1" "Data"
kaya-cli sheets rename-sheet 1abc123 "Old Name" "New Name"
```

### copy-sheet
Copy a sheet/tab within the same spreadsheet or to another.

```bash
# Copy within same spreadsheet
kaya-cli sheets copy-sheet 1abc123 "Template"

# Copy to different spreadsheet
kaya-cli sheets copy-sheet 1abc123 "Template" --to 2xyz456
```

### duplicate
Clone an entire spreadsheet (creates a new copy).

```bash
kaya-cli sheets duplicate 1abc123                    # Auto-names "Copy of ..."
kaya-cli sheets duplicate 1abc123 "My Copy"          # Custom name
kaya-cli sheets duplicate 1abc123 "Backup" --json    # Returns new ID
```

---

## Phase 3: Data Intelligence

### find
Search for values across a sheet.

```bash
kaya-cli sheets find 1abc123 "search term"
kaya-cli sheets find 1abc123 "john" --sheet="Employees"
kaya-cli sheets find 1abc123 "error" --json
```

**Output includes:** cell reference (e.g., B5), row, column, and matched value.

### sort
Sort a range by a specified column.

```bash
kaya-cli sheets sort 1abc123 "A1:D100" --by=B           # Ascending by column B
kaya-cli sheets sort 1abc123 "A1:D100" --by=C --desc    # Descending by column C
kaya-cli sheets sort 1abc123 "Sheet1!A2:Z100" --by=A    # Skip header row
```

### filter
Filter rows based on column conditions (returns matching rows).

```bash
# Numeric comparisons
kaya-cli sheets filter 1abc123 "A1:D100" --col=B --gt=100      # Greater than
kaya-cli sheets filter 1abc123 "A1:D100" --col=B --lt=50       # Less than
kaya-cli sheets filter 1abc123 "A1:D100" --col=B --gte=100     # Greater or equal
kaya-cli sheets filter 1abc123 "A1:D100" --col=B --lte=50      # Less or equal

# String comparisons
kaya-cli sheets filter 1abc123 "A1:D100" --col=C --eq="active"       # Exact match
kaya-cli sheets filter 1abc123 "A1:D100" --col=C --neq="inactive"    # Not equal
kaya-cli sheets filter 1abc123 "A1:D100" --col=C --contains="error"  # Contains text

# JSON output for piping
kaya-cli sheets filter 1abc123 "A1:D100" --col=B --gt=100 --json
```

### formula
Set a formula in a cell.

```bash
kaya-cli sheets formula 1abc123 "E2" "=SUM(A2:D2)"
kaya-cli sheets formula 1abc123 "F1" "=AVERAGE(B:B)"
kaya-cli sheets formula 1abc123 "Sheet1!G2" "=VLOOKUP(A2,Data!A:B,2,FALSE)"
```

### named-ranges
Manage named ranges in a spreadsheet.

```bash
# List all named ranges
kaya-cli sheets named-ranges 1abc123 list
kaya-cli sheets named-ranges 1abc123 list --json

# Add a named range
kaya-cli sheets named-ranges 1abc123 add "Sales" "Sheet1!A1:B10"
kaya-cli sheets named-ranges 1abc123 add "Headers" "Data!A1:Z1"

# Delete a named range
kaya-cli sheets named-ranges 1abc123 delete "Sales"
```

---

## Phase 4: Formatting & Sharing

### format
Apply formatting to a range of cells.

```bash
# Text formatting
kaya-cli sheets format 1abc123 "A1:B1" --bold
kaya-cli sheets format 1abc123 "A1:B1" --italic
kaya-cli sheets format 1abc123 "A1:B1" --bold --italic

# Colors (hex format)
kaya-cli sheets format 1abc123 "A1:B1" --bg=#4285F4        # Background
kaya-cli sheets format 1abc123 "A1:B1" --fg=#FFFFFF        # Text color
kaya-cli sheets format 1abc123 "A1:B1" --bg=#FF0000 --fg=#FFFFFF

# Alignment
kaya-cli sheets format 1abc123 "A1:B1" --align=center
kaya-cli sheets format 1abc123 "A1:B1" --align=left
kaya-cli sheets format 1abc123 "A1:B1" --align=right

# Combined
kaya-cli sheets format 1abc123 "A1:D1" --bold --bg=#4285F4 --fg=#FFFFFF --align=center
```

### freeze
Freeze rows and/or columns in a sheet.

```bash
kaya-cli sheets freeze 1abc123 "Sheet1" --rows=1           # Freeze header row
kaya-cli sheets freeze 1abc123 "Sheet1" --cols=1           # Freeze first column
kaya-cli sheets freeze 1abc123 "Sheet1" --rows=1 --cols=2  # Both
kaya-cli sheets freeze 1abc123 "Data" --rows=2             # Freeze 2 rows
```

### share
Share a spreadsheet with a user.

```bash
kaya-cli sheets share 1abc123 user@example.com                    # Default: reader
kaya-cli sheets share 1abc123 user@example.com --role=reader      # View only
kaya-cli sheets share 1abc123 user@example.com --role=writer      # Can edit
kaya-cli sheets share 1abc123 user@example.com --role=commenter   # Can comment
```

### permissions
List who has access to a spreadsheet.

```bash
kaya-cli sheets permissions 1abc123
kaya-cli sheets permissions 1abc123 --json
```

### protect
Protect a range from edits.

```bash
kaya-cli sheets protect 1abc123 "Sheet1!A1:A10"
kaya-cli sheets protect 1abc123 "Data!A1:Z1" --description="Header row - do not edit"
```

---

## Pipe Composition

```bash
# Export sheet to TSV file
kaya-cli sheets read 1abc123 --tsv > data.tsv

# Count rows
kaya-cli sheets read 1abc123 --json | jq length

# Get specific column
kaya-cli sheets read 1abc123 "A:A" --json | jq -r '.[][]'

# Find sheets containing term
kaya-cli sheets list --json | jq -r '.[] | select(.name | contains("Budget")) | .id'

# Read and transform
kaya-cli sheets read 1abc123 --json | jq 'map({name: .[0], value: .[1]})'

# Chain operations: export, transform, re-import
kaya-cli sheets export 1abc123 --csv | \
  awk -F, '{print toupper($1)","$2}' | \
  kaya-cli sheets import 2xyz456

# Find and report
kaya-cli sheets find 1abc123 "ERROR" --json | jq -r '.[] | "\(.cell): \(.value)"'
```

---

## Data Format

Write/append data must be JSON array of arrays:
```json
[
  ["row1col1", "row1col2", "row1col3"],
  ["row2col1", "row2col2", "row2col3"]
]
```

---

## Authentication

Uses Google OAuth2. Run initial setup:
```bash
bash ~/.claude/tools/UnixCLI/configure-google-auth.sh
```

Token stored at: `~/.config/google/sheets-token.json`

---

## Use Cases

### DTR/TELOS Data Access
```bash
# Read goals from TELOS spreadsheet
kaya-cli sheets read <telos_sheet_id> "Goals!A:D" --json

# Append new tracking entry
kaya-cli sheets append <tracking_id> "[[\"$(date)\",\"Completed task\",\"5\"]]"
```

### Quick Data Lookup
```bash
# Find value in column
kaya-cli sheets read 1abc123 "A:B" --json | jq '.[] | select(.[0] == "key") | .[1]'

# Search for specific term
kaya-cli sheets find 1abc123 "urgent" --json | jq '.[0].cell'
```

### Batch Updates
```bash
# Read, transform, write back
data=$(kaya-cli sheets read 1abc123 --json)
transformed=$(echo "$data" | jq 'map(.[0] |= ascii_upcase)')
kaya-cli sheets write 1abc123 "A1:Z1000" "$transformed"
```

### Spreadsheet Templates
```bash
# Create from template
new_id=$(kaya-cli sheets duplicate <template_id> "Q1 Report" --json | jq -r '.id')
kaya-cli sheets write "$new_id" "A1" '[["Generated: '"$(date)"'"]]'
```

### Data Analysis Pipeline
```bash
# Filter high-value items, sort, export
kaya-cli sheets filter 1abc123 "A1:D100" --col=B --gt=1000 --json | \
  jq 'sort_by(.[1]) | reverse' | \
  kaya-cli sheets write 2xyz456 "A1"
```

---

## Troubleshooting

**Authentication Error**
```bash
# Re-authenticate
rm ~/.config/google/sheets-token.json
bash ~/.claude/tools/UnixCLI/configure-google-auth.sh
```

**Spreadsheet Not Found**
- Verify the spreadsheet ID (from URL: `https://docs.google.com/spreadsheets/d/<ID>/edit`)
- Ensure you have access to the spreadsheet

**Invalid Range**
- Use format: `SheetName!A1:B10`
- Sheet names with spaces: `'Sheet Name'!A1:B10`

**Permission Denied**
- Check you have edit access for write operations
- Use `kaya-cli sheets permissions <id>` to verify access level

**Import Not Working**
- Ensure data is piped: `cat file.csv | kaya-cli sheets import <id>`
- Check delimiter matches (default CSV, use `--tsv` for tab-separated)
