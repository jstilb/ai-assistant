# DeepTechnicalAnalysis Workflow

Comprehensive technical implementation audit of a Kaya skill. Focuses on code-level analysis, dependency mapping, execution flow tracing, and gap identification between stated purpose and actual implementation.

---

## Trigger

- "deep analysis of [skill]"
- "technical audit [skill]"
- "analyze [skill] implementation"
- "detailed skill breakdown [skill]"
- "how does [skill] actually work"

---

## Purpose

Provides technical implementation analysis to complement the strategic evaluation in AuditSingle. Where AuditSingle answers "Is this skill valuable and well-designed?", DeepTechnicalAnalysis answers "How does this skill actually work, and what's the gap between stated and actual behavior?"

---

## Execution

### Phase 1: Discovery & Inventory

**1.1 Locate and catalog all skill files**
```bash
# Get complete file structure
find ~/.claude/skills/[SkillName] -type f -name "*.ts" -o -name "*.js" -o -name "*.md"

# Count files by type
find ~/.claude/skills/[SkillName] -type f | grep -E '\.(ts|js|md)$' | wc -l
```

**1.2 Build file inventory**
Create structured list:
- Documentation files (*.md)
- Tool implementations (Tools/*.ts)
- Workflow definitions (Workflows/*.md)
- Configuration files (if any)
- Test files (if any)

**1.3 Read all content**
Read every file to build complete understanding.

---

### Phase 2: Behavior Analysis (Expected vs Actual vs Ideal)

**2.1 Extract Expected Behavior**

From SKILL.md, document:
- **Stated Purpose:** What does the description claim this skill does?
- **Declared Triggers:** What USE WHEN conditions are specified?
- **Workflow Promises:** What does each workflow claim to accomplish?
- **Integration Claims:** What does it claim to connect with?
- **Example Scenarios:** What use cases are documented?

**2.2 Analyze Actual Behavior**

From Tools/ and Workflows/, document:
- **Implemented Functions:** What code actually exists?
- **Real Triggers:** What patterns actually invoke this skill?
- **Actual Workflows:** What steps do workflows actually execute?
- **Real Integrations:** What other skills/tools are actually called?
- **Working Scenarios:** Which examples are actually implemented?

**2.3 Define Ideal Behavior**

Based on skill domain and user needs:
- **Ideal Purpose:** What should this skill do to maximize value?
- **Ideal Triggers:** What invocation patterns would be most intuitive?
- **Ideal Workflows:** What workflows would provide euphoric surprise?
- **Ideal Integrations:** What connections would maximize utility?
- **Ideal Scenarios:** What use cases should be supported?

**2.4 Gap Analysis**

Create three-column comparison:

| Aspect | Expected (Docs) | Actual (Code) | Ideal (Vision) | Gap Level |
|--------|----------------|---------------|----------------|-----------|
| Purpose | [from docs] | [from code] | [defined] | HIGH/MED/LOW |
| Triggers | [documented] | [implemented] | [ideal] | HIGH/MED/LOW |
| Workflow X | [promised] | [actual] | [ideal] | HIGH/MED/LOW |

**Gap Level Criteria:**
- **HIGH:** Major discrepancy, broken promise, or missing critical functionality
- **MEDIUM:** Partial implementation, incomplete feature, or unclear documentation
- **LOW:** Minor difference, documentation lag, or slight deviation

---

### Phase 3: Comprehensive Dependency Mapping

**3.1 File-Level Dependencies**

For each .ts/.js file, extract:
```typescript
// Parse imports
import { X } from 'path/to/module'
require('module-name')

// Document:
- Internal imports (other skill files)
- CORE tool imports (~/.claude/skills/CORE/Tools/)
- Node/Bun built-ins
- External packages (node_modules)
```

**3.2 Skill-Level Dependencies**

Search for skill invocations:
```bash
# Find Skill tool calls
grep -r "Skill({" ~/.claude/skills/[SkillName]/

# Find Task tool calls with subagent_type
grep -r "Task({" ~/.claude/skills/[SkillName]/

# Document which skills this skill depends on
```

**3.3 Tool Dependencies**

Map CORE tool usage:
- NotificationService
- StateManager
- ConfigLoader
- CachedHTTPClient
- MemoryStore
- ApprovalQueue
- AgentOrchestrator
- WorkflowExecutor

**3.4 MCP Dependencies**

Search for MCP usage:
```bash
# Find MCP tool calls
grep -r "mcp__" ~/.claude/skills/[SkillName]/

# Document which MCP servers are used
```

**3.5 External Dependencies**

Check for:
- package.json dependencies
- API endpoints called (curl, fetch)
- External services (databases, cloud services)
- File system dependencies (specific paths required)

**3.6 Dependency Graph**

Generate visual representation:
```
[SkillName]
├─ Internal Files
│  ├─ Tools/Tool1.ts → CORE/NotificationService
│  └─ Tools/Tool2.ts → CORE/StateManager
├─ Other Skills
│  ├─ Uses: Agents, System, Browser
│  └─ Used By: CreateSkill, Upgrades
├─ MCP Servers
│  └─ mcp__asana__ (for task management)
└─ External
   ├─ Node: fs, path
   └─ NPM: none
```

---

### Phase 4: Execution Flow Analysis

**4.1 Trigger-to-Output Mapping**

For each workflow, trace complete path:

```
WORKFLOW: [WorkflowName]

INPUT/TRIGGER:
  User says: "[trigger phrase]"
  Skill tool invoked with: [args]

EXECUTION STEPS:
  1. Read config from [location]
  2. Call [Tool/Function] with [params]
     ├─ If [condition]: branch A
     │  └─ Call [SubTool]
     └─ Else: branch B
        └─ Call [OtherTool]
  3. Aggregate results
  4. Notify via [channel]

OUTPUTS:
  - File written to: [path]
  - User notification: [message]
  - State updated: [location]
  - Returns: [data structure]

ERROR HANDLING:
  - [Error type]: [Recovery action]
  - Fallbacks: [defined/undefined]
```

**4.2 Decision Tree Mapping**

Document all conditional logic:
- What decisions are made during execution?
- What data drives those decisions?
- Are all branches reachable?
- Are there dead code paths?

**4.3 Parallel vs Sequential Operations**

Identify:
- **Parallel operations:** Multiple agents spawned, concurrent HTTP requests
- **Sequential operations:** Step-by-step workflow phases
- **Blocking operations:** User approvals, external API calls
- **Async operations:** Background tasks, fire-and-forget notifications

**4.4 Data Flow**

Track data transformation:
```
[Input Data] → [Transform 1] → [Transform 2] → [Output Data]

Example:
User request → Parse skill name → Read skill files →
Analyze structure → Score dimensions → Format report →
Save to MEMORY
```

---

### Phase 5: Redundancy Detection

**5.1 Duplicate Code Patterns**

Search for:
- Repeated code blocks across tools
- Similar functions with minor variations
- Copy-pasted logic that should be abstracted
- Redundant error handling

**5.2 Overlapping Workflow Functionality**

Compare workflows:
- Do multiple workflows accomplish similar goals?
- Could workflows be consolidated?
- Are there redundant phases across workflows?

**5.3 Redundant Tool Implementations**

Check if tools:
- Duplicate CORE tool functionality
- Reimplement existing Kaya utilities
- Overlap with other skill's tools
- Could use existing MCP servers instead

**5.4 Similar Trigger Patterns**

Identify trigger overlap:
- Do triggers conflict with other skills?
- Are there redundant trigger phrases?
- Could triggers be consolidated?

**5.5 Redundancy Report**

For each redundancy found:
```markdown
### Redundancy: [Brief Description]

**Location:** [File:Line or Workflow name]

**Type:** [Code duplication / Workflow overlap / Tool redundancy / Trigger conflict]

**Impact:** [HIGH/MEDIUM/LOW]

**Evidence:**
- [Specific example 1]
- [Specific example 2]

**Recommendation:**
[How to eliminate the redundancy]

**Effort:** [LOW/MEDIUM/HIGH]
```

---

### Phase 6: Generate Comprehensive Report

**6.1 Executive Summary (Brief)**

1-2 paragraphs covering:
- Skill's core technical function
- Implementation quality assessment
- Key strengths (2-3 bullets)
- Key issues (2-3 bullets)
- Overall technical health (GREEN/YELLOW/RED)

**6.2 Detailed Technical Breakdown**

Full report structure:

```markdown
# Deep Technical Analysis: [SkillName]

**Analyzed:** [Date]
**Analyst:** Kaya (Kaya SkillAudit)
**Analysis Type:** Implementation Deep Dive

---

## Executive Summary

[1-2 paragraph brief summary]

**Technical Health:** 🟢 GREEN / 🟡 YELLOW / 🔴 RED

**Key Strengths:**
- [Strength 1]
- [Strength 2]
- [Strength 3]

**Key Issues:**
- [Issue 1]
- [Issue 2]
- [Issue 3]

---

## Skill Overview

### Stated Purpose
[From SKILL.md description]

### File Inventory
- **Documentation:** [N] files
- **Tools:** [N] files
- **Workflows:** [N] files
- **Total LOC:** [estimate from all .ts/.js files]

### Complexity Assessment
- **Workflows:** [Simple/Moderate/Complex]
- **Tools:** [Simple/Moderate/Complex]
- **Dependencies:** [Few/Moderate/Many]

---

## Behavior Analysis

### Expected vs Actual vs Ideal

#### Purpose
| Expected (Documented) | Actual (Implemented) | Ideal (Vision) | Gap |
|-----------------------|----------------------|----------------|-----|
| [docs claim] | [code reality] | [what it should be] | 🔴 HIGH / 🟡 MED / 🟢 LOW |

#### Triggers
| Expected | Actual | Ideal | Gap |
|----------|--------|-------|-----|
| [trigger 1] | [implemented?] | [ideal phrase] | [level] |
| [trigger 2] | [implemented?] | [ideal phrase] | [level] |

#### Workflows
[For each workflow]

**Workflow: [Name]**
- **Expected:** [What docs say it does]
- **Actual:** [What code actually does]
- **Ideal:** [What it should do]
- **Gap:** [Assessment]

### Critical Gaps

1. **[Gap Name]** - [HIGH/MEDIUM/LOW]
   - **Description:** [What's missing or broken]
   - **Impact:** [How this affects utility]
   - **Fix:** [How to close the gap]

---

## Dependency Analysis

### Dependency Summary
- Internal Files: [N]
- CORE Tools: [list]
- Other Skills: [list]
- MCP Servers: [list]
- External Deps: [list]

### Dependency Graph

```
[Detailed ASCII/Mermaid graph from Phase 3]
```

### Dependency Health Assessment

| Dependency Type | Count | Health | Notes |
|-----------------|-------|--------|-------|
| CORE Tools | [N] | 🟢/🟡/🔴 | [appropriate/excessive/missing] |
| Other Skills | [N] | 🟢/🟡/🔴 | [well-integrated/loosely-coupled/isolated] |
| MCP Servers | [N] | 🟢/🟡/🔴 | [utilized/underutilized/over-relied] |
| External | [N] | 🟢/🟡/🔴 | [appropriate/excessive/fragile] |

### Dependency Risks

- **[Risk 1]:** [Description + mitigation]
- **[Risk 2]:** [Description + mitigation]

---

## Execution Flow Analysis

### Workflow Execution Maps

[For each workflow, include full trigger-to-output trace from Phase 4.1]

### Decision Points

| Workflow | Decision Point | Condition | Branch A | Branch B |
|----------|---------------|-----------|----------|----------|
| [name] | [description] | [condition] | [action] | [action] |

### Parallelization Opportunities

**Current Parallel Operations:**
- [List existing parallel operations]

**Potential Parallel Operations:**
- [Where parallelization could be added]
- [Expected performance improvement]

### Data Flow Map

```
[Comprehensive data flow diagram from Phase 4.4]
```

### Error Handling Assessment

| Workflow/Tool | Error Handling | Grade |
|---------------|----------------|-------|
| [name] | [description] | 🟢 Comprehensive / 🟡 Partial / 🔴 Missing |

---

## Redundancy Analysis

### Redundancy Summary
- Code Duplications: [N] found
- Workflow Overlaps: [N] found
- Tool Redundancies: [N] found
- Trigger Conflicts: [N] found

### Detailed Redundancy Report

[For each redundancy, include full report from Phase 5.5]

### Elimination Plan

**Quick Wins (Low Effort, High Impact):**
1. [Redundancy to eliminate + approach]

**Strategic Refactors (Medium Effort, High Impact):**
1. [Redundancy to eliminate + approach]

**Long-term Considerations (High Effort):**
1. [Redundancy to eliminate + approach]

---

## Code Quality Assessment

### Strengths
- [Specific code quality strength with evidence]
- [Another strength]

### Issues
- [Specific code quality issue with evidence]
- [Another issue]

### Recommendations
1. **[Recommendation]**
   - **Why:** [Justification]
   - **How:** [Specific implementation steps]
   - **Effort:** [LOW/MEDIUM/HIGH]

---

## Technical Debt Inventory

### High Priority Debt
1. **[Debt Item]**
   - **Impact:** [Description]
   - **Cost of Delay:** [What happens if not fixed]
   - **Fix Effort:** [Estimate]

### Medium Priority Debt
[Similar structure]

### Low Priority Debt
[Similar structure]

---

## Path to Ideal State

### Current State
[Technical description of where skill is now]

### Ideal State
[Technical description of where skill should be]

### Gap Closure Roadmap

**Phase 1: Critical Gaps (Immediate)**
- [ ] [Gap to close]
- [ ] [Gap to close]

**Phase 2: Enhancement (Near-term)**
- [ ] [Enhancement]
- [ ] [Enhancement]

**Phase 3: Optimization (Long-term)**
- [ ] [Optimization]
- [ ] [Optimization]

**Total Estimated Effort:** [hours/days/weeks]

---

## Comparison to Similar Skills

### Internal Comparison
- **[Similar Kaya Skill]:** [How this compares]
- **[Another Similar Skill]:** [How this compares]

### External Comparison
- **[External Tool/Framework]:** [How they solve similar problems]
- **Patterns to Adopt:** [Specific patterns worth borrowing]

---

## Recommendations Summary

### Immediate Actions (Do Now)
1. [Action with rationale]

### Near-term Improvements (This Month)
1. [Action with rationale]

### Strategic Enhancements (This Quarter)
1. [Action with rationale]

---

## Appendix

### Tool-by-Tool Breakdown

[For each tool in Tools/]

**Tool: [ToolName.ts]**
- **Purpose:** [What it does]
- **LOC:** [Lines of code]
- **Dependencies:** [What it imports]
- **Used By:** [Which workflows call it]
- **Quality:** [Assessment]
- **Issues:** [Any problems]

### Workflow-by-Workflow Breakdown

[For each workflow in Workflows/]

**Workflow: [WorkflowName.md]**
- **Purpose:** [What it does]
- **Complexity:** [Simple/Moderate/Complex]
- **Tools Used:** [List]
- **Execution Time:** [Estimate]
- **Quality:** [Assessment]
- **Issues:** [Any problems]

---

## Metadata

**Analysis Completed:** [Timestamp]
**Analysis Duration:** [How long this took]
**Files Analyzed:** [N]
**Total LOC Reviewed:** [N]
**Findings Generated:** [N]
```

---

## Output Location

Save report to: `~/.claude/MEMORY/SkillAudits/[SkillName]-Technical-[YYYY-MM-DD].md`

Naming convention distinguishes from evaluation audits:
- Evaluation audit: `[SkillName]-[YYYY-MM-DD].md`
- Technical audit: `[SkillName]-Technical-[YYYY-MM-DD].md`

---

## Success Criteria

- [ ] All five analysis phases completed
- [ ] Expected/Actual/Ideal comparison documented for all major aspects
- [ ] Complete dependency graph generated
- [ ] All workflows have execution flow maps
- [ ] Redundancies identified and classified
- [ ] Both brief and detailed summaries provided
- [ ] Actionable recommendations with effort estimates
- [ ] Report saved to MEMORY with proper naming

---

## Integration with AuditSingle

These two workflows complement each other:

| Aspect | AuditSingle (Evaluation) | DeepTechnicalAnalysis (Implementation) |
|--------|-------------------------|---------------------------------------|
| **Focus** | Strategic value, design quality | Technical implementation, code reality |
| **Questions** | Is it valuable? Well-designed? | How does it work? What's the gap? |
| **Output** | Report card with scores | Technical breakdown with flows |
| **Audience** | Product/strategic decisions | Engineering/implementation decisions |
| **Effort** | Medium (subjective evaluation) | High (detailed code analysis) |

**Recommended Usage:**
1. Run **AuditSingle** first for high-level health check
2. If issues found or major changes planned, run **DeepTechnicalAnalysis**
3. Use both reports together for comprehensive understanding

---

## Tools Used

This workflow uses the following SkillAudit tools:

| Tool | Purpose | Command |
|------|---------|---------|
| **SkillInventory.ts** | Discovery and metrics | `bun run Tools/SkillInventory.ts [SkillName]` |
| **SkillScorer.ts** | Structure and complexity scoring | `bun run Tools/SkillScorer.ts [SkillName]` |
| **DependencyMapper.ts** | Dependency graph generation | `bun run Tools/DependencyMapper.ts --format mermaid` |
| **BehaviorGapAnalyzer.ts** | Expected/Actual/Ideal comparison | `bun run Tools/BehaviorGapAnalyzer.ts [SkillName]` |
| **RedundancyDetector.ts** | Code duplication detection | `bun run Tools/RedundancyDetector.ts [SkillName]` |

**All tools are in:** `~/.claude/skills/SkillAudit/Tools/`

---

## Future Enhancements

- **Automated Code Analysis:** Parse TypeScript AST to extract actual behavior
- **Runtime Tracing:** Instrument skill execution to capture actual flows
- **Diff Analysis:** Compare current implementation to previous audits
- **Performance Profiling:** Measure execution time, memory usage
- **Test Coverage Analysis:** Identify untested code paths
