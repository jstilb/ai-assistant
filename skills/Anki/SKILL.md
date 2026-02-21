---
name: Anki
description: Direct Anki flashcard management via CLI. USE WHEN create flashcard, anki card, deck management, review stats, note type, batch cards, anki sync.
---

# Anki - Flashcard Management System

Direct interface to Anki for card creation, deck management, and spaced repetition workflows using `apy` CLI.

---

## CLI Commands Available

| Command | Purpose | Example |
|---------|---------|---------|
| `apy add-single` | Create single card | `apy add-single -d "Deck" "Front" "Back"` |
| `apy add` | Interactive card creation | `apy add` |
| `apy add-from-file` | Bulk import from Markdown | `apy add-from-file cards.md` |
| `apy list-notes` | Search/list notes | `apy list-notes "deck:Python"` |
| `apy list-cards` | List cards matching query | `apy list-cards "is:due"` |
| `apy list-cards-table` | Tabular card listing | `apy list-cards-table "deck:*"` |
| `apy list-models` | Show available note types | `apy list-models` |
| `apy info` | Collection statistics | `apy info` |
| `apy review` | Review/edit matching notes | `apy review "is:due"` |
| `apy edit` | Edit notes matching query | `apy edit "front:*python*"` |
| `apy tag` | Add/remove tags | `apy tag -a "new-tag" "deck:MyDeck"` |
| `apy sync` | Sync with AnkiWeb | `apy sync` |
| `apy backup` | Backup database | `apy backup ~/anki-backup.apkg` |

---

## Workflow Routing

| Trigger | Workflow | Action |
|---------|----------|--------|
| "create card", "add flashcard" | **QuickCard** | Single card creation |
| "batch cards", "multiple cards" | **BatchCreate** | Bulk card creation |
| "anki decks", "list decks" | **DeckManagement** | Deck operations |
| "anki stats", "review stats" | **Analytics** | Review statistics |
| "search anki", "find cards" | **Search** | Find existing cards |

---

## Quick Reference

### Card Types

**Basic** (Front/Back fields):
```bash
apy add-single -d "MyDeck" -m "Basic" "What is the capital of France?" "Paris"
```

**Cloze** (Text field with deletions):
```bash
apy add-single -m "Cloze" "The {{c1::mitochondria}} is the {{c2::powerhouse}} of the cell."
```

### Deck Naming Convention

`Category::Subcategory::Topic`

Examples:
- `Obsidian::MIDS::Statistics`
- `Languages::Japanese::Vocabulary`
- `Programming::Python::Libraries`

---

## Execution Steps

### QuickCard Workflow

1. **Parse user input** for front/back content
2. **Determine deck:**
   - User specified → Use that deck
   - Context clues → Infer from topic
   - Default → `Inbox::QuickCapture`
3. **Check note type:**
   - Has cloze deletions → Use `-m Cloze`
   - Standard Q&A → Use `-m Basic` (default)
4. **Create card:**
   ```bash
   apy add-single -d "DeckName" -t "tag1 tag2" "Front content" "Back content"
   ```
5. **Confirm** with deck location

### BatchCreate Workflow

1. **Create Markdown file** with cards:
   ```markdown
   model: Basic
   deck: MyDeck
   tags: topic1 topic2

   # Note
   Front content here

   ## Back
   Back content here

   # Note
   Another front

   ## Back
   Another back
   ```
2. **Import cards:**
   ```bash
   apy add-from-file cards.md
   ```
3. **Report results:**
   - Cards created
   - Any failures
   - Deck location

### DeckManagement Workflow

1. **List existing decks:**
   ```bash
   apy info
   ```
2. **For creation:** Decks auto-create when cards are added
3. **Report** deck structure

### Analytics Workflow

1. **Get collection stats:**
   ```bash
   apy info
   ```
2. **List due cards:**
   ```bash
   apy list-cards-table "is:due"
   ```
3. **Analyze by deck:**
   ```bash
   apy list-cards-table "deck:DeckName is:due"
   ```
4. **Present summary** table

### Search Workflow

1. **Parse search criteria:**
   - Deck filter: `deck:"DeckName"`
   - Content: `front:*keyword*` or `back:*keyword*`
   - Tags: `tag:tagname`
   - Due status: `is:due` or `is:new`
2. **Execute search:**
   ```bash
   apy list-notes "deck:Python front:*api*"
   ```
3. **Return matching cards** with details

---

## Examples

**Example 1: Quick card creation**
```bash
# User: "Add a flashcard: What is REST? / Representational State Transfer"
apy add-single -d "Inbox::QuickCapture" "What is REST?" "Representational State Transfer"
```

**Example 2: Batch creation with tags**
```bash
# User: "Create vocab cards in Japanese::N5"
apy add-single -d "Japanese::N5" -t "n5 greetings" "ありがとう" "Thank you"
apy add-single -d "Japanese::N5" -t "n5 greetings" "おはよう" "Good morning"
apy add-single -d "Japanese::N5" -t "n5 greetings" "さようなら" "Goodbye"
```

**Example 3: Cloze cards**
```bash
# User: "Create cloze card for Declaration of Independence"
apy add-single -m "Cloze" "The {{c1::Declaration of Independence}} was signed in {{c2::1776}}"
```

**Example 4: Search and review**
```bash
# User: "Find all my Python cards that are due"
apy list-cards-table "deck:*Python* is:due"
```

**Example 5: Collection overview**
```bash
# User: "Show me my Anki stats"
apy info
```

**Example 6: Sync with AnkiWeb**
```bash
apy sync
```

---

## Configuration

Set Anki base path (where database lives):

```bash
# Option 1: Environment variable
export APY_BASE="$HOME/Library/Application Support/Anki2"

# Option 2: Config file ~/.config/apy/apy.json
{
  "base_path": "/Users/username/Library/Application Support/Anki2"
}

# Option 3: Command line flag
apy -b "/path/to/anki" info
```

---

## Voice Notification

Use `notifySync()` from `skills/CORE/Tools/NotificationService.ts`

---
---

## Integration

- **ContinualLearning:** Captures insights as flashcards for retention

---

## Best Practices

1. **Tags:** Add topic tags with `-t "tag1 tag2"`
2. **Source tracking:** Include note reference in tags
3. **Batch imports:** Use Markdown files for 10+ cards
4. **Deck hierarchy:** Use `::` for organization (auto-creates parents)
5. **Duplicates:** Search before creating with `apy list-notes`
6. **Sync regularly:** Run `apy sync` to backup to AnkiWeb
