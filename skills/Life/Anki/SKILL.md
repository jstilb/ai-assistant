---
name: Anki
description: Direct Anki flashcard management via CLI, plus hands-free interactive voice review. USE WHEN create flashcard, anki card, deck management, review stats, note type, batch cards, anki sync, voice review, quiz me, review my cards out loud, answer flashcards verbally.
---

# Anki - Flashcard Management System

Direct interface to Anki for card creation, deck management, and spaced repetition workflows using `apy` CLI.

---

## CLI Commands Available

| Command | Purpose | Example |
|---------|---------|---------|
| `AnkiClient.ts add` | Create single card | `bun ~/.claude/skills/Life/Anki/Tools/AnkiClient.ts add "Deck" "Front" "Back"` |
| `AnkiClient.ts decks` | List all decks | `bun ~/.claude/skills/Life/Anki/Tools/AnkiClient.ts decks` |
| `AnkiClient.ts due` | Review due cards | `bun ~/.claude/skills/Life/Anki/Tools/AnkiClient.ts due [deck]` |
| `AnkiClient.ts sync` | Sync with AnkiWeb | `bun ~/.claude/skills/Life/Anki/Tools/AnkiClient.ts sync` |
| `AnkiClient.ts validate` | Validate prerequisites | `bun ~/.claude/skills/Life/Anki/Tools/AnkiClient.ts validate` |
| `VoiceReviewSession.ts start` | **Interactive voice review** | `bun ~/.claude/skills/Life/Anki/Tools/VoiceReviewSession.ts start [deck] [--limit=N]` |
| `AnkiConnectClient.ts check` | Check AnkiConnect reachable | `bun ~/.claude/skills/Life/Anki/Tools/AnkiConnectClient.ts check` |
| `DanceMoves.ts learn` | **Log a dance move learned** (hip hop, salsa/bachata) | `bun ~/.claude/skills/Life/Anki/Tools/DanceMoves.ts learn "cross-body lead" --where "Thu class"` |

---

## Workflow Routing

| Trigger | Workflow | Action |
|---------|----------|--------|
| "create card", "add flashcard" | **QuickCard** | Single card creation |
| "batch cards", "multiple cards" | **BatchCreate** | Bulk card creation |
| "anki decks", "list decks" | **DeckManagement** | Deck operations |
| "anki stats", "review stats" | **Analytics** | Review statistics |
| "search anki", "find cards" | **Search** | Find existing cards |
| "voice review", "quiz me out loud", "review verbally", "answer my cards by voice" | **VoiceReview** | Hands-free spoken review |
| "learned a move", "add a dance move", "moves learned", "salsa/bachata/hip hop move" | **DanceMoves** | `DanceMoves.ts learn` / `add` (see Moves Learned) |

---

## Interactive Voice Review (hands-free)

Kaya reads each due card's question aloud, listens to your spoken answer,
assesses it against the card's back, speaks feedback, and marks the card in
Anki with the right ease — no keyboard, no screen.

```bash
# Review up to 20 due cards across all decks
bun ~/.claude/skills/Life/Anki/Tools/VoiceReviewSession.ts start

# Review a specific deck, cap at 10 cards
bun ~/.claude/skills/Life/Anki/Tools/VoiceReviewSession.ts start "Learning::Piano" --limit=10

# Higher-accuracy STT (slower)
bun ~/.claude/skills/Life/Anki/Tools/VoiceReviewSession.ts start --model=small.en
```

**Per-card loop:** speak question → capture spoken answer (STT) → LLM grades it →
`answerCards` in Anki with the assessed ease → speak feedback + the ease chosen.

**Spoken control words** (said instead of an answer):

| Say | Effect |
|-----|--------|
| "repeat" / "say again" | Re-read the current question |
| "skip" / "next" | Move on, leave the card due (no grade) |
| "stop" / "quit" / "end review" / "that's enough" | End the session |

**Grading → ease mapping** (in `AnkiAnswerAssessor.ts`, graded generously for
meaning, not wording):

| Verdict | Anki button | When |
|---------|-------------|------|
| correct (confident, complete) | 4 Easy | full, confident answer |
| correct (slightly incomplete) | 3 Good | correct substance |
| partial | 2 Hard | gist there, key part missing |
| incorrect / no answer / "I don't know" | 1 Again | wrong or empty |

If the LLM grader can't be reached, the card is **safely re-shown** (marked
Again) and Kaya says so — nothing is silently marked known.

**Prerequisite:** unlike the `apy`-based commands, voice review talks to the
**AnkiConnect add-on** (code `2055492159`) over HTTP (localhost:8765), because
`apy review` is interactive-only and can't be driven programmatically. Anki must
be running with AnkiConnect installed. Check with:

```bash
bun ~/.claude/skills/Life/Anki/Tools/AnkiConnectClient.ts check
```

Also requires the desktop voice stack (mic via `sox`, local Whisper STT, and
mlx-audio TTS) — see the **VoiceInteraction** skill for setup. Session activity
is logged to `MEMORY/Life/anki-voice-review.jsonl`.

---

## Moves Learned (hip hop, salsa & bachata)

A **Moves Learned** section under each dance subject: one card per move. The front shows the move name and asks you to stand up and dance it for 8 counts. The back has the breakdown (counts and cues from the 2026-09 curricula) and a **clickable YouTube tutorial with a thumbnail**, plus your own clip if you add one.

```
Learning::Hip Hop Dance::Moves Learned      32 moves (grooves B01, party grooves B05–B06, popping B08–B10, shuffle B20–B21)
Learning::Salsa & Bachata::Moves Learned    21 moves (salsa basics, CBL, turns, copa, hammerlock, shines, Cuban; bachata basics, turns, footwork, body wave)
```

**How it works:** the catalogue (`Data/dance-moves.json`, note type **"Kaya Dance Move"**) sits in Anki as **suspended** cards. They cost no review time and don't touch the 3-new/day budget. When you've actually learned a move, `learn` unsuspends it, stamps the date and where you learned it, and makes it **due tomorrow**, the curriculum's ≥ 24 h retention check. After that it's on normal spacing. Anki must be **closed**, or pass `--quit-anki` (quits Anki, runs, reopens).

```bash
T=~/.claude/skills/Life/Anki/Tools/DanceMoves.ts
bun $T catalogue salsa                               # keys + names (no Anki access)
bun $T learn "cross-body lead" --where "Thu class w/ T"
bun $T learn hh-running-man --clip "https://photos.app.goo.gl/…"   # attach your own recording
bun $T add salsa "Sombrero" --video "https://youtu.be/…" --where "Sat class" --breakdown "…"   # move not in the catalogue
bun $T list hiphop --learned                         # what you've learned so far
bun $T unlearn sb-copa                               # suspend it again
bun $T sync                                          # after editing Data/dance-moves.json (idempotent; updates fields in place)
```

Names resolve by key, exact name or unique substring. Ambiguous names list the candidates. `sync` only ever edits template text and CSS, never note-type fields, because a field change forces a one-way full AnkiWeb sync. Every catalogue video was checked against YouTube oEmbed when added. Any new `video` must be an https URL. Tests: `bun test ~/.claude/skills/Life/Anki/Tools/__tests__/DanceMoves.test.ts` (runs against a temp collection, never the real one). Backup taken before the first live sync: `backups/collection-pre-dance-moves-2026-09-29.anki2`.

---

## Quick Reference

### Card Types

**Basic** (Front/Back fields):
```bash
bun ~/.claude/skills/Life/Anki/Tools/AnkiClient.ts add "MyDeck" "What is the capital of France?" "Paris"
```

**Cloze** (Text field with deletions):
```bash
# Note: Cloze cards require model override — use raw apy for now
# bun AnkiClient.ts add "MyDeck" "{{c1::mitochondria}} is the {{c2::powerhouse}} of the cell." ""
```

### Deck Structure (consolidated 2026-09-24)

Every deck in Jm's collection lives under **one study parent, `Learning`**. Jm clicks `Learning` once a day; nothing else sits at the top level (apart from Anki's built-in empty `Default` deck).

```
Learning                                  preset "Learning (all subjects)"
├── <Subject>                             preset "Learning subject"  (1 new/day)
│   └── Bnn <Block Title> …               curriculum block sub-decks (Default preset; gated by parents)
├── Cooking                               ← was top-level `Cooking`
├── Data Science                          ← was top-level; keeps its own "Data Science" preset (1 new / 10 reviews)
└── Music Theory & Composition            ← was music_theory + Music Intervals + Musical Notes
    ├── Music Theory / Music Intervals / Musical Notes
```

The 14 subjects: Climbing, Cooking, Data Science, Hip Hop Dance, Improv, Information Ecosystems, Massage, Music Production, Music Theory & Composition, Piano, Salsa & Bachata, Software Architecture, Surfing, Volleyball. Subject names match LifeOS `skill_mastery_active.skill`, so `Learning::<skill>` resolves without a mapping.

**Daily limits (live as of 2026-09-24, set by Jm):**

| Setting | Value | Why |
|---------|-------|-----|
| `Learning` new cards/day | **3** | Jm's ruling: "the more important thing is to build the habit." Deliberately low. Not every subject gets a new card every day, and that's fine. |
| `Learning` reviews/day | **30** | Keeps a session at about 5–10 minutes (S16 is ≥ 5 min/day of show-up). |
| Per-subject new cards/day | 1 | Stops any one subject taking the whole daily allowance. |
| New-card gather order (parent) | **Random notes** | With 3 slots and 14 subjects, gathering deck by deck would feed only the alphabetically first subjects forever. Random rotates every subject over time. Cost: within a subject, cards no longer arrive in strict B00→B14 order. |
| "Limits start from top" | **On** (Jm) | Clicking straight into one subject still respects the `Learning` totals. |
| "New cards ignore review limit" | Off | Safe only because the review backlog is 0 (see reset below). In Anki's v3 scheduler the review limit also gates new cards. If a backlog builds above 30, new cards stop until it clears. Turn this on if that happens. |

**Don't raise these limits unless Jm asks.** Jm asked for them to be "manageable, even if it seems 'too low'".

**Why one parent deck, not a filtered "Custom Study" deck:** a filtered deck has to be rebuilt by hand every day, ignores per-deck limits (so it can't spread new cards across subjects), and there's only one slot, which gets overwritten. A parent deck gives a one-click daily session and uses the v3 scheduler's per-subdeck limits to spread new material across every subject.

**Old-deck reset (2026-09-24):** Data Science, Music Theory & Composition and Cooking hadn't been studied since July. Their 1,379 non-new cards were reset to New (Browse → Cards → Reset, with "restore original position" and "reset repetition and lapse counts" both ticked). Review history is kept. Overdue reviews went from 1,281 to 0, and every card in the collection is now New.

**Rules when adding decks:**
- **New subject** → create it as a *direct* child `Learning::<Subject>` and assign the **"Learning subject"** preset. Otherwise it gets `Default` (5 new/day) and skews the balance. `ensure-deck` creates the deck but does **not** set the preset. Set it with Anki closed:
  ```python
  from anki.collection import Collection
  c = Collection('/Users/[user]/Library/Application Support/Anki2/User 1/collection.anki2')
  did = c.decks.id("Learning::<Subject>")
  conf = next(x for x in c.decks.all_config() if x["name"] == "Learning subject")
  deck = c.decks.get(did); deck["conf"] = conf["id"]; c.decks.save(deck); c.close()
  ```
  Also add it as a LifeOS learning target with the same `skill` name, so `learningDeckFor` (in `skills/Productivity/LifeOS/Aggregation/SkillMastery.ts`) finds its reviews.
- **Curriculum blocks / sub-topics** → `Learning::<Subject>::…` (e.g. `Learning::Cooking::Curriculum::B03 Braising`). No preset needed: the subject and parent limits gate them.
- **Never create a top-level deck.** Code that reads a subject's deck must go through `learningDeckFor(skill)` (→ `Learning::<skill>`), never a hand-typed name. The old `SKILL_DECK_OVERRIDES` map (Cooking → top-level `Cooking`) was deleted in the consolidation.
- A `DeckManager.children(did)` call returns *all* descendants, not just direct children. Filter on `::` depth.

**Rollback:** backups `collection-pre-learning-consolidation-2026-09-24.anki2` and `collection-pre-reset-old-decks-2026-09-24.anki2` in `~/Library/Application Support/Anki2/User 1/backups/`. To restore, close Anki and copy one over `collection.anki2`.

---

## Execution Steps

### QuickCard Workflow

1. **Parse user input** for front/back content
2. **Determine deck:**
   - User specified → Use that deck
   - Context clues → Infer the subject → `Learning::<Subject>` (see Deck Structure)
   - No subject fits → ask Jm (new subject deck + preset) rather than inventing a top-level deck
3. **Check note type:**
   - Has cloze deletions → Use `-m Cloze`
   - Standard Q&A → Use `-m Basic` (default)
4. **Create card:**
   ```bash
   bun ~/.claude/skills/Life/Anki/Tools/AnkiClient.ts add "DeckName" "Front content" "Back content" tag1 tag2
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
   bun ~/.claude/skills/Life/Anki/Tools/AnkiClient.ts decks
   ```
2. **For creation:** Decks do NOT auto-create (apy raises KeyError for unknown decks) — run `bun ~/.claude/skills/Life/Anki/Tools/AnkiClient.ts ensure-deck "<Deck::Name>"` before adding cards to a new deck
3. **Report** deck structure

### Analytics Workflow

1. **Get collection stats:**
   ```bash
   bun ~/.claude/skills/Life/Anki/Tools/AnkiClient.ts decks
   ```
2. **List due cards:**
   ```bash
   bun ~/.claude/skills/Life/Anki/Tools/AnkiClient.ts due
   ```
3. **Analyze by deck:**
   ```bash
   bun ~/.claude/skills/Life/Anki/Tools/AnkiClient.ts due DeckName
   ```
4. **Present summary** table

### Search Workflow

1. **Parse search criteria:**
   - For due cards in specific deck, use AnkiClient.ts
2. **Execute search:**
   ```bash
   bun ~/.claude/skills/Life/Anki/Tools/AnkiClient.ts due DeckName
   ```
3. **Return matching cards** with details

---

## Examples

**Example 1: Quick card creation**
```bash
# User: "Add a flashcard: What is REST? / Representational State Transfer"
bun ~/.claude/skills/Life/Anki/Tools/AnkiClient.ts add "Learning::Software Architecture" "What is REST?" "Representational State Transfer"
```

**Example 2: Batch creation with tags**
```bash
# User: "Add sauce cards to my cooking deck"
bun ~/.claude/skills/Life/Anki/Tools/AnkiClient.ts add "Learning::Cooking::Mother Sauces" "Which mother sauce is thickened with a blond roux and milk?" "Béchamel" sauces
bun ~/.claude/skills/Life/Anki/Tools/AnkiClient.ts add "Learning::Cooking::Mother Sauces" "Which mother sauce is an emulsion of egg yolk and butter?" "Hollandaise" sauces
```

**Example 3: List all decks**
```bash
# User: "Show me my Anki decks"
bun ~/.claude/skills/Life/Anki/Tools/AnkiClient.ts decks
```

**Example 4: Review due cards**
```bash
# User: "What cards are due in my piano deck?"
bun ~/.claude/skills/Life/Anki/Tools/AnkiClient.ts due "Learning::Piano"
```

**Example 5: Sync with AnkiWeb**
```bash
bun ~/.claude/skills/Life/Anki/Tools/AnkiClient.ts sync
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

- addCard success: "Card added to {deck}"
- syncAnki success: "Anki synced with AnkiWeb"

---
---

## Integration

- **AgentMetacognition:** Captures insights as flashcards for retention
- **VoiceInteraction:** Voice review reuses the desktop STT (`lib/core/VoiceInput.ts`) and TTS (`VoiceResponseGenerator.speakText`) stack
- **Inference:** `lib/core/Inference.ts` grades spoken answers (standard tier) in `AnkiAnswerAssessor.ts`
- **AnkiConnect:** Programmatic due-card fetch + scheduling for voice review (`AnkiConnectClient.ts`); `apy` remains the path for authoring/sync

---

## Best Practices

1. **Tags:** Add topic tags with `-t "tag1 tag2"`
2. **Source tracking:** Include note reference in tags
3. **Batch imports:** Use Markdown files for 10+ cards
4. **Deck hierarchy:** Everything goes under `Learning::<Subject>` (see Deck Structure). Create decks via `ensure-deck` first, since nothing auto-creates, and give any new direct subject the "Learning subject" preset
5. **Duplicates:** Search before creating with `apy list-notes`
6. **Sync regularly:** Run `apy sync` to backup to AnkiWeb
