# Organize-ScratchPad Workflow

Process free-form items from the scratch pad note, categorize by intent, and route to appropriate destinations.

**Category:** Organize (Route/Move)
**Trigger:** `organize scratch pad`, `process scratch pad`, `triage inbox`, `clear scratch pad`

## Purpose

Route scratch pad items to their proper locations:
- Calendar events → Google Calendar
- Tasks → Asana
- Kaya tasks → QueueRouter approvals queue
- New notes → Obsidian vault
- Existing note additions → Append to target notes

This is an **Organize** workflow: it routes information from an inbox to proper destinations.

## Configuration

**Scratch Pad:** `/Users/[user]/Desktop/obsidian/Scratch Pad.md`
**Vault Context:** `/Users/[user]/Desktop/obsidian/VaultContext.md`
**Vault Root:** `/Users/[user]/Desktop/obsidian/`

## Execution Steps

### 1. Pre-flight Checks

1. Read scratch pad file
2. Load VaultContext.md for folder routing decisions
3. Check MCP availability:
   - Google Calendar MCP (for events)
   - Asana MCP (for tasks)
4. If MCP unavailable, warn and process other categories

### 2. Parse Scratch Pad

Extract items from the scratch pad:
- Each line starting with `-` or numbered list item
- Skip frontmatter, headings, and "Needs Review" section
- Preserve any grouping context

### 3. Categorize Each Item

Analyze each item to determine intent:

| Category | Indicators | Action |
|----------|------------|--------|
| **Calendar Event** | Time refs ("Tuesday", "2pm", "tomorrow"), "meeting", "call with", people + time | Create Google Calendar event via MCP |
| **Kaya Task** | "#kaya", "@kaya", "kaya:", dev/research/content tasks for autonomous processing | Add to QueueRouter approvals queue |
| **Task** | Action verbs ("call", "buy", "submit"), deadlines ("by Friday"), errands, lists | Create Asana task via MCP |
| **New Note** | "research", "idea about", "look into", knowledge-oriented, no time binding | Create note in appropriate vault folder |
| **Existing Note** | "add to my X notes", "append to", references known vault content | Append to target note |
| **Multi-Category** | Contains both scheduling AND content | Split into components, process each, cross-link |
| **Unclear** | Ambiguous, missing context, fragments | Move to "Needs Review" section |

### 4. Route by Category

#### Calendar Events (Google Calendar MCP)

```
1. Extract: title, datetime, duration, attendees
2. Parse relative dates: "Tuesday" -> next Tuesday, "2pm" -> 14:00
3. Default duration: 30 minutes
4. Lookup attendee emails from Contacts.md if names mentioned
5. Call MCP: create_event
```

#### Kaya Tasks (QueueRouter Approvals Queue)

```
Detection: Item contains "#kaya", "@kaya", "kaya:", or is clearly a dev/research/content task

1. Extract: title, description (full item text)
2. Classify work type:
   - "dev", "code", "feature", "bug", "implement" → type: dev
   - "research", "investigate", "analyze" → type: research
   - "write", "content", "document", "blog" → type: content
3. Add to QueueRouter approvals queue:
   bun run ~/.claude/skills/Automation/QueueRouter/Tools/QueueManager.ts add \
     --queue approvals \
     --title "Task title" \
     --description "Full item text" \
     --type dev \
     --source scratchpad
4. Run AI enrichment:
   bun run ~/.claude/skills/Automation/QueueRouter/Tools/ItemEnricher.ts enrich <item-id>

Flow: scratchpad → approvals queue → spec review → approved-work → autonomous execution
```

#### Tasks (Asana MCP)

```
Detection: Regular tasks WITHOUT #kaya tag (personal errands, calls, etc.)

1. Extract: title, due date, project context
2. Convert comma lists to subtasks: "eggs, milk, bread" -> checklist
3. Infer workspace from context (work vs personal)
4. Call MCP: create_task

IF ASANA MCP UNAVAILABLE:
- Add tasks to the queue using QueueManager:
  bun $KAYA_DIR/skills/Automation/QueueRouter/Tools/QueueManager.ts add --title "Task title" --description "Details" --queue approved-work --payload '{"source":"scratchpad-processing"}'
- This routes tasks through the standard QueueRouter pipeline
- Tasks will be picked up by /work next command later
```

#### New Notes

```
1. Determine folder via VaultContext.md:
   - Academic topics -> course folders
   - Technical -> Data Science/, Programming/, etc.
   - Personal -> Meta/, Ideas/, etc.
   - Recipes -> Cooking/
   - Unknown -> root or prompt user
2. Create note with frontmatter:
   ---
   created: {{date}}
   tags: [{{inferred_tags}}]
   source: scratch-pad
   ---
3. Track note path for post-processing integration
```

**After all notes created -> Call Organize-Note workflow:**
```
-> Organize-Note(note_path, is_new: true, source: "scratch-pad")
-> Creates backlinks to related notes
-> Updates folder's _Index.md
-> Updates relevant MOCs
-> Refreshes folder's _Context.md
```

#### Existing Note Additions

```
1. Search vault for target note (glob + grep)
2. Read current content
3. Append new content under appropriate section
4. Update frontmatter with modification date
```

#### Multi-Category Items

```
1. Split into distinct intents
2. Process each category handler
3. Cross-link outputs:
   - Calendar event description -> link to note
   - Task note field -> reference to related note
4. Report all created artifacts together
```

#### Unclear Items

```
1. Move to "Needs Review" section in scratch pad
2. Add annotation explaining why unclear:
   - *[Unclear: vague reference - needs more context]*
   - *[Unclear: ambiguous date - which Tuesday?]*
```

### 5. Update Scratch Pad

After processing:

1. **Remove** processed items from main section
2. **Move** unclear items to "Needs Review" with annotations
3. **Update** frontmatter: `last_processed: {{current_date}}`
4. **Preserve** any unprocessed structural content

### 6. Report Results

```markdown
## Scratch Pad Processing Complete

**Processed:** {{count}} items
**Created notes:** {{notes_list}}
**Created tasks:** {{tasks_list}}
**Created events:** {{events_list}}
**Needs review:** {{unclear_count}}

### Actions Taken
[Detailed list of what was created/modified with links]

### Needs Review
[List of unclear items with reasons]
```

## Dry Run Mode

When invoked with "dry run" or "preview":

1. Parse and categorize all items (same as normal)
2. **DO NOT execute** any actions
3. Display preview:

```markdown
## Scratch Pad Processing Preview (DRY RUN)

| # | Item | Category | Proposed Action |
|---|------|----------|-----------------|
| 1 | Call mom about birthday | Task | Create Asana task |
| 2 | Meeting with Sarah Tuesday 2pm | Calendar | Create event: Tue 2:00 PM |
| 3 | Research gradient boosting | New Note | Create: Data Science/Gradient Boosting.md |

Proceed with processing? (re-run without "dry run")
```

## Error Handling

| Scenario | Action |
|----------|--------|
| Scratch pad doesn't exist | Error - inform user to create it |
| VaultContext.md missing | Warn, use basic routing |
| Google Calendar MCP unavailable | Queue calendar items, process others |
| Asana MCP unavailable | Add tasks to queue via QueueManager, process others |
| Date parsing ambiguous | Move to Needs Review with options |
| Target note not found | Create new note, inform user |
| Multiple folder matches | Use best match, log alternatives |

## Tools Called

- `ProcessScratchPad.ts` (optional)

## Integration

**MCPs Used:**
- `google-calendar` - Event creation
- `asana` - Task creation

**Workflows Called:**
- `Organize-Note` - For each new note created (backlinks, index, MOC updates)
- `Refresh-VaultFolder` - Called by Organize-Note to refresh folder context

**Files Modified:**
- Scratch pad (remove processed, add to Needs Review)
- Target notes (append content)
- New notes (create in vault)
- `_Index.md` files (add new notes)
- `_Context.md` files (refresh folder inventory)

**Context Loaded:**
- VaultContext.md - For folder routing decisions
- Contacts.md - For attendee email lookup

## Orchestration Flow

```
Organize-ScratchPad
+-- Parse items
+-- Categorize
+-- Route to destinations
|   +-- Calendar -> Google Calendar MCP
|   +-- Kaya Tasks (#kaya tagged) -> QueueRouter approvals queue
|   |   +-- Add to approvals queue
|   |   +-- Run AI enrichment
|   |   +-- Await spec approval -> approved-work -> autonomous execution
|   +-- Tasks (non-Kaya) -> Asana MCP
|   +-- New Notes -> Create in vault
|   |   +-- -> Organize-Note (for each)
|   |       +-- Add backlinks
|   |       +-- Update _Index.md
|   |       +-- Update MOCs
|   |       +-- -> Refresh-VaultFolder
|   |           +-- Refresh _Context.md
|   +-- Existing Notes -> Append content
+-- Update scratch pad
+-- Report results
```
