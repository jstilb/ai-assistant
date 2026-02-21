# Obsidian Syntax Reference

Quick reference for Obsidian-flavored markdown.

## Links

**Wikilinks:**
- `[[Note Name]]` - Link to note
- `[[Note Name|Display Text]]` - Link with custom text
- `[[Note Name#Heading]]` - Link to heading
- `[[Note Name#^block-id]]` - Link to block

**Embeds:**
- `![[Note Name]]` - Embed entire note
- `![[Note Name#Heading]]` - Embed section
- `![[image.png]]` - Embed image

## Tags

**Inline:** `#tag` `#nested/tag`

**Frontmatter:**
```yaml
tags: [tag1, tag2, nested/tag]
```

## Frontmatter

YAML between `---` markers at file start:
```yaml
---
created: 2024-01-14
tags: [topic, status]
aliases: [alternate name]
cssclasses: [custom-class]
---
```

## Callouts

```markdown
> [!note] Title
> Content here

> [!tip] Pro tip
> Helpful advice

> [!warning] Caution
> Important warning

> [!info] Information
> Additional context

> [!abstract] Summary
> Key points
```

**Foldable:** Add `-` or `+` after type:
```markdown
> [!info]- Collapsed by default
> Hidden content

> [!info]+ Expanded by default
> Visible content
```

## Dataview

**Inline queries:**
- `` `=this.file.name` `` - Current filename
- `` `=date(today)` `` - Today's date
- `` `=this.tags` `` - Note's tags

**Block queries:**
```dataview
LIST FROM #tag
WHERE file.mtime > date(today) - dur(7 days)
SORT file.mtime DESC
```

## Task Syntax

```markdown
- [ ] Unchecked task
- [x] Completed task
- [/] In progress
- [-] Cancelled
```
