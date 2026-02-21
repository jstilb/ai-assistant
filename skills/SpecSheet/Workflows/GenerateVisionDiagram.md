# GenerateVisionDiagram Workflow

**Generate visual diagrams for vision tier specifications using the Art skill's Mermaid workflow.**

This workflow creates Excalidraw-aesthetic Mermaid diagrams that visualize the three-tier vision hierarchy and individual spec architectures.

## Purpose

Vision specs benefit from visual representation:
- **Solarpunk Vision** → State diagram of ideal user states
- **Grounded Ideal** → Flowchart of system architecture
- **Current Work** → State diagram of implementation workflow
- **Vision Cascade** → Shows Solarpunk → Grounded → Current relationships

---

## Diagram Types

### 1. Vision Cascade Diagram

**Shows the three-tier hierarchy and how they relate.**

```
Trigger: "vision cascade diagram", "show vision hierarchy"
```

**Structure:**
```
SOLARPUNK VISION (Utopian North Star)
    │ Features categorized by achievability
    │ Non-negotiables identified
    ▼
GROUNDED IDEAL (Achievable Excellence)
    │ Technology constraints applied
    │ Milestones defined
    ▼
CURRENT WORK (Practical Path)
    │ ISC rows for execution
    │ Feeds into THEALGORITHM
```

**Mermaid Type:** Flowchart (top-to-bottom)

**Color Scheme:**
- Solarpunk: Purple (aspirational)
- Grounded: Teal (achievable)
- Current Work: Black (actionable)
- Arrows: Black with labels

---

### 2. Solarpunk Vision Diagram

**State diagram showing ideal user experience states.**

```
Trigger: "solarpunk diagram", "vision state diagram"
```

**Structure:**
```
[Initial Need] → (anticipation) → [Need Satisfied]
              → (zero friction) → [Delight State]
              → (invisible tech) → [Human Flourishing]
```

**Mermaid Type:** State Diagram

**Extraction from Solarpunk Spec:**
- User states from Section 2.1 (Anticipatory Moments)
- Transitions from Section 2.2 (Zero-Friction Interactions)
- Delight moments from Section 2.3

---

### 3. Grounded Ideal Diagram

**Flowchart showing practical system architecture.**

```
Trigger: "grounded diagram", "architecture diagram"
```

**Structure:**
```
User Interface → API Gateway → Core Logic → Data Layer
                           ↓
                    External Services
```

**Mermaid Type:** Flowchart

**Extraction from Grounded Ideal Spec:**
- Components from Section 3.1
- Integration points from Section 3.2
- Data flow from Section 3.3

---

### 4. Current Work Diagram

**State diagram showing implementation workflow.**

```
Trigger: "current work diagram", "implementation diagram"
```

**Structure:**
```
[Planning] → [Development] → [Testing] → [Review] → [Done]
                         ↓
                    [Blocked]
```

**Mermaid Type:** State Diagram

**Extraction from Current Work Spec:**
- States from implementation steps (Section 5.3)
- Verification gates (Section 6)
- ISC verification flow

---

## Execution Steps

### Step 1: Identify Spec and Diagram Type

```
Header: "Diagram Type"
Question: "What type of vision diagram do you want to create?"
Options:
- "Vision Cascade" - Show Solarpunk → Grounded → Current hierarchy
- "Solarpunk States" - Ideal user experience state diagram
- "Grounded Architecture" - System architecture flowchart
- "Current Work Flow" - Implementation workflow state diagram
```

### Step 2: Load Source Spec

Based on diagram type, load the relevant spec:

| Diagram Type | Source Spec |
|--------------|-------------|
| Vision Cascade | All three (or available subset) |
| Solarpunk States | Solarpunk Vision |
| Grounded Architecture | Grounded Ideal |
| Current Work Flow | Current Work |

```bash
# Find and load relevant specs
ls ~/.claude/Plans/Specs/*{{domain}}*.md
```

### Step 3: Extract Diagram Structure

**Run CSE-style analysis on the spec content:**

From the loaded spec, identify:
- **Nodes:** States, components, or process steps
- **Edges:** Transitions, data flows, or relationships
- **Labels:** Conditions, triggers, or descriptions
- **Emphasis:** Critical path (purple), secondary (teal)

### Step 4: Invoke Art Skill Mermaid Workflow

**Reference:** `skills/Art/Workflows/Mermaid.md`

**Key Parameters:**

```yaml
diagram_type: {{flowchart|stateDiagram-v2}}
aesthetic: excalidraw_whiteboard
color_scheme:
  critical: "#4A148C"  # Deep Purple
  secondary: "#00796B"  # Deep Teal
  structure: "#000000"  # Black
  text: "#2D2D2D"       # Charcoal
  background: "#F5E6D3" # Light Cream (or white)

aspect_ratio:
  flowchart_vertical: "9:16"
  flowchart_horizontal: "16:9"
  state_diagram: "16:9"

model: nano-banana-pro  # Best for text-heavy diagrams
```

### Step 5: Generate Diagram

**Construct comprehensive prompt following Art skill pattern:**

```
Hand-drawn Mermaid [DIAGRAM_TYPE] in Excalidraw whiteboard sketch style.

STYLE: Excalidraw hand-drawn, whiteboard sketch, wobbly shapes
BACKGROUND: Light Cream #F5E6D3

DIAGRAM STRUCTURE:
[Extracted nodes and edges from spec]

COLOR USAGE:
- Purple #4A148C: Critical/primary path
- Teal #00796B: Secondary/alternative paths
- Black #000000: Structure and arrows
- Charcoal #2D2D2D: All text labels

TYPOGRAPHY:
- Tier 1: Diagram title (Valkyrie serif italic, large)
- Tier 2: Node labels (Concourse T3, medium)
- Tier 3: Edge labels (smaller, hand-written style)

NODES:
[List each node with shape, label, color, position]

CONNECTIONS:
[List each arrow with path, label, style]

EXCALIDRAW AESTHETIC:
- Wobbly rectangles, not perfect
- Sketchy arrows with slight curves
- Hand-lettered text
- Organic connections
```

### Step 6: Save and Display

**Output location:**
```
~/.claude/Plans/Specs/Diagrams/{{domain}}-{{type}}-diagram.png
```

**Immediately open:**
```bash
open ~/.claude/Plans/Specs/Diagrams/{{domain}}-{{type}}-diagram.png
```

---

## Diagram Templates

### Vision Cascade Template

```mermaid
flowchart TB
    subgraph Solarpunk["🌱 SOLARPUNK VISION"]
        S1[Human Experience]
        S2[Environmental Harmony]
        S3[Tech Integration]
    end

    subgraph Grounded["⚡ GROUNDED IDEAL"]
        G1[Achievable Excellence]
        G2[Practical Architecture]
        G3[Milestone Path]
    end

    subgraph Current["🔧 CURRENT WORK"]
        C1[ISC Rows]
        C2[Implementation]
        C3[Verification]
    end

    Solarpunk --> |Constraints Applied| Grounded
    Grounded --> |Milestone 1| Current
    Current --> |Feeds Into| ALGO[THEALGORITHM]

    classDef solarpunk fill:#4A148C,color:white
    classDef grounded fill:#00796B,color:white
    classDef current fill:#000000,color:white

    class S1,S2,S3 solarpunk
    class G1,G2,G3 grounded
    class C1,C2,C3 current
```

### Solarpunk States Template

```mermaid
stateDiagram-v2
    [*] --> NeedArises

    NeedArises --> Anticipated: System anticipates
    NeedArises --> Expressed: User expresses

    Anticipated --> Satisfied: Zero friction
    Expressed --> Satisfied: Minimal effort

    Satisfied --> Delighted: Exceeds expectations
    Satisfied --> Flourishing: Outcome achieved

    Delighted --> Flourishing: Sustained delight

    Flourishing --> [*]: Human flourishing

    note right of Anticipated
        Technology invisible
        Context-aware
    end note

    note right of Delighted
        Exceeded expectations
        Moments of joy
    end note
```

### Grounded Architecture Template

```mermaid
flowchart TB
    subgraph User["User Layer"]
        UI[Interface]
        Voice[Voice]
    end

    subgraph Core["Core System"]
        API[API Gateway]
        Logic[Business Logic]
        AI[AI Processing]
    end

    subgraph Data["Data Layer"]
        DB[(Database)]
        Cache[(Cache)]
    end

    UI --> API
    Voice --> API
    API --> Logic
    Logic --> AI
    Logic --> DB
    AI --> Cache

    classDef critical fill:#4A148C,color:white
    classDef secondary fill:#00796B,color:white

    class API,Logic critical
    class AI,DB secondary
```

### Current Work Flow Template

```mermaid
stateDiagram-v2
    [*] --> Planning: Spec approved

    Planning --> Development: Plan confirmed
    Planning --> Blocked: Dependency missing

    Development --> Testing: Code complete
    Development --> Blocked: Issue found

    Blocked --> Planning: Resolved

    Testing --> Review: Tests pass
    Testing --> Development: Tests fail

    Review --> Done: Approved
    Review --> Development: Changes requested

    Done --> [*]: Deployed

    note right of Development
        ISC rows guide work
        Verification at each step
    end note
```

---

## Integration

### Uses
- **Art skill** — Mermaid workflow for generation
- **Vision tier specs** — Source content for diagrams

### Output
- PNG images in `~/.claude/Plans/Specs/Diagrams/`
- Can be embedded in specs or shared

---

## Example Usage

```
User: "Generate vision cascade diagram for PKM system"

→ Load PKM Solarpunk Vision, Grounded Ideal, Current Work specs
→ Extract key components from each tier
→ Build cascade flowchart structure
→ Invoke Art skill with Excalidraw aesthetic
→ Generate with nano-banana-pro
→ Save to ~/. claude/Plans/Specs/Diagrams/pkm-vision-cascade.png
→ Open for user review
```

```
User: "Create architecture diagram from grounded ideal"

→ Load Grounded Ideal spec
→ Extract components from Section 3
→ Build flowchart with component boxes
→ Mark critical path in purple
→ Generate with Excalidraw aesthetic
→ Save and display
```

---

**Last Updated:** 2026-02-01
