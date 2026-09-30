# Telos Artifact App Design

## Dashboard Building Strategy

**CRITICAL: When building UIs, use up to 16 parallel engineers.**

**Launch Strategy (single message, 10 Task calls in parallel):**

```
Engineer 1: Project structure + layout + navigation
Engineer 2: Overview page with metrics cards
Engineer 3: Projects page with progress tracking
Engineer 4: Teams page with performance tables
Engineer 5: Vulnerabilities/issues page
Engineer 6: Progress timeline visualization
Engineer 7: Data parsing library (MD/CSV)
Engineer 8: Shared components (cards, badges, tables)
Engineer 9: Design polish and theme
Engineer 10: Integration and testing
```

## Tech Stack

- Next.js 15 + TypeScript
- Tailwind CSS 4
- Lucide React icons
- Tokyo Night Day theme (professional light)

## Features

- Dependency graphs (Mermaid diagrams)
- Progress tables (sortable, filterable)
- Metrics cards (KPIs, stats)
- Timeline visualizations
- Relationship networks

## Design Variables

```css
--background: #ffffff
--foreground: #1a1b26
--primary: #2e7de9
--accent: #9854f1
--destructive: #f52a65
--success: #33b579
--warning: #f0a020
```
