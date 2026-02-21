<!--
================================================================================
Kaya CORE - USER/TECHSTACKPREFERENCES.md
================================================================================

PURPOSE:
Your technology stack preferences. Your AI uses this to make consistent
technology choices across all development work - languages, package managers,
formats, and workflow patterns.

LOCATION:
- Kai (Private): ${KAYA_DIR}/skills/CORE/USER/TECHSTACKPREFERENCES.md
- Kaya Pack: Packs/pai-core-install/src/skills/CORE/USER/TECHSTACKPREFERENCES.md

CUSTOMIZATION:
- [ ] Adjust language preferences to match your stack
- [ ] Update package manager preferences
- [ ] Modify format standards as needed
- [ ] Add your own workflow patterns

RELATED FILES:
- SYSTEM/TOOLS.md - CLI utilities reference
- SYSTEM/CLIFIRSTARCHITECTURE.md - CLI-first design patterns
- ALGOPREFS.md - AI behavior customizations

LAST UPDATED: 2026-01-08
VERSION: 1.1.0
================================================================================
-->

# Stack Preferences

**Your Technology Stack Preferences - Definitive Reference**

This document captures your core technology stack preferences for Kaya infrastructure and all development work.

---

## Languages

### Primary Language: Python

**Primary Rule:** Use Python for data science, analysis, and general scripting.

**When to Use Python:**
- All new infrastructure development
- Data analysis and machine learning
- Command-line tools and utilities
- Default choice for all new projects

**When TypeScript/Other is Acceptable:**
- Web development / Frontend
- Config files requiring JSON/YAML/JS

---

## Package Managers

### Python: pip

**Commands:**
```bash
# Install packages
pip install package-name

# Requirements
pip freeze > requirements.txt
pip install -r requirements.txt
```

### JavaScript/TypeScript: npm/bun

**Commands:**
```bash
# Install dependencies
npm install

# Add a new package
npm install package-name
```

---

## Formats & Standards

### Documentation Format: Markdown

**Primary Rule:** Use Markdown for all documentation.

**Acceptable HTML:**
- Custom components (`<aside>`, `<details>`, `<summary>`)
- Interactive elements requiring specific behavior

**Avoid HTML for:**
- Basic paragraphs, headers, lists
- Links and emphasis
- Code blocks and tables

---

## Workflow Patterns

### Git Practices

**Style:** Commit often with simple descriptions and merge when branch work is done.

**Commit Messages:**
- Simple and descriptive
- Example: "update user contact info" or "fix data processing bug"
- Merge strategy: Merge branch when work is complete

### Analysis vs Action: Explicit Intent Required

**Analysis Tasks (Read-Only):**
- "Analyze the authentication flow"
- "Review this code for issues"
- "What's wrong with this implementation?"

**Action Tasks (Modifications Allowed):**
- "Fix the authentication bug"
- "Refactor this code"
- "Implement the new feature"

**Rule:** If asked to analyze, do analysis ONLY - don't change things unless explicitly asked.

---

## Terminal & Browser

### Terminal: Terminal.app

Use the standard macOS Terminal.

### Browser: Google Chrome

```bash
# Open a URL
open -a "Google Chrome" "http://localhost:5200"
```

---

## Summary Reference Card

```
LANGUAGES:
  Primary: Python
  Secondary: TypeScript

PACKAGE MANAGERS:
  JS/TS: Bun
  Python: Pip

FORMATS:
  Documentation: Markdown
  Config: JSON/YAML

WORKFLOW:
  Analysis → Read only, report findings
  Action → Modify with confidence
```

---

**This is the definitive reference for stack preferences. When in doubt, consult this document.**
