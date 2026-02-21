# Debate Workflow

Full structured multi-agent debate with 3 rounds and visible transcript.

## Prerequisites

- Topic or question to debate
- Optional: Custom council members (default: architect, designer, engineer, researcher)

## Execution

### Step 1: Announce the Council

Output the debate header:

```markdown
## Council Debate: [Topic]

**Council Members:** [List agents participating]
**Rounds:** 3 (Positions → Responses → Synthesis)
```

### Step 2: Round 1 - Initial Positions

Launch 4 parallel Task calls (one per council member).

**Each agent prompt includes:**
```
You are [Agent Name], [brief role description from AgentPersonalities.md].

COUNCIL DEBATE - ROUND 1: INITIAL POSITIONS

Topic: [The topic being debated]

Give your initial position on this topic from your specialized perspective.
- Speak in first person as your character
- Be specific and substantive (50-150 words)
- State your key concern, recommendation, or insight
- You'll respond to other council members in Round 2

Your perspective focuses on: [agent's domain]
```

**Agent domains:**
- **architect**: System design, patterns, scalability, long-term architectural implications
- **designer**: User experience, accessibility, user needs, interface implications
- **engineer**: Implementation reality, tech debt, maintenance burden, practical constraints
- **researcher** (ClaudeResearcher): Data, precedent, external examples, what others have done

**Output each response as it completes:**
```markdown
### Round 1: Initial Positions

**🏛️ Architect (Serena):**
[Response]

**🎨 Designer (Aditi):**
[Response]

**⚙️ Engineer (Marcus):**
[Response]

**🔍 Researcher (Ava):**
[Response]
```

### Step 3: Round 2 - Responses & Challenges

Launch 4 parallel Task calls with Round 1 transcript included.

**Each agent prompt includes:**
```
You are [Agent Name], [brief role description].

COUNCIL DEBATE - ROUND 2: RESPONSES & CHALLENGES

Topic: [The topic being debated]

Here's what the council said in Round 1:
[Full Round 1 transcript]

Now respond to the other council members:
- Reference specific points they made ("I disagree with [Name]'s point about X...")
- Challenge assumptions or add nuance
- Build on points you agree with
- Maintain your specialized perspective
- 50-150 words

The value is in genuine intellectual friction—engage with their actual arguments.
```

**Output:**
```markdown
### Round 2: Responses & Challenges

**🏛️ Architect (Serena):**
[Response referencing others' points]

**🎨 Designer (Aditi):**
[Response referencing others' points]

**⚙️ Engineer (Marcus):**
[Response referencing others' points]

**🔍 Researcher (Ava):**
[Response referencing others' points]
```

### Step 4: Round 3 - Synthesis

Launch 4 parallel Task calls with Round 1 + Round 2 transcripts.

**Each agent prompt includes:**
```
You are [Agent Name], [brief role description].

COUNCIL DEBATE - ROUND 3: SYNTHESIS

Topic: [The topic being debated]

Full debate transcript so far:
[Round 1 + Round 2 transcripts]

Final synthesis from your perspective:
- Where does the council agree?
- Where do you still disagree with others?
- What's your final recommendation given the full discussion?
- 50-150 words

Be honest about remaining disagreements—forced consensus is worse than acknowledged tension.
```

**Output:**
```markdown
### Round 3: Synthesis

**🏛️ Architect (Serena):**
[Final synthesis]

**🎨 Designer (Aditi):**
[Final synthesis]

**⚙️ Engineer (Marcus):**
[Final synthesis]

**🔍 Researcher (Ava):**
[Final synthesis]
```

### Step 5: Council Synthesis

After all rounds complete, synthesize the debate:

```markdown
### Council Synthesis

**Areas of Convergence:**
- [Points where 3+ agents agreed]
- [Shared concerns or recommendations]

**Remaining Disagreements:**
- [Points still contested between agents]
- [Trade-offs that couldn't be resolved]

**Recommended Path:**
[Based on convergence and weight of arguments, the recommended approach is...]
```

## Custom Council Members

If user specifies custom members, adjust accordingly:

- "Council with security" → Add pentester agent
- "Council with intern" → Add intern agent (fresh perspective)
- "Council with writer" → Add writer agent (communication focus)
- Omit agents: "Just architect and engineer" → Only those two

## Agent Type Mapping

| Council Role | Task subagent_type | Personality Reference |
|--------------|-------------------|----------------------|
| Architect | Architect | Serena Blackwood |
| Designer | Designer | Aditi Sharma |
| Engineer | Engineer | Marcus Webb |
| Researcher | ClaudeResearcher | Ava Chen |
| Security | Pentester | Rook Blackburn |
| Intern | Intern | Dev Patel |
| Writer | (use Intern with writer prompt) | Emma Hartley |

## Timing

- Round 1: ~10-20 seconds (parallel)
- Round 2: ~10-20 seconds (parallel)
- Round 3: ~10-20 seconds (parallel)
- Synthesis: ~5 seconds

**Total: 30-90 seconds for full debate**

## Agent Teams Mode

When the `TeamsBridge` is available AND the council has more than 2 positions, use Agent Teams for direct peer-to-peer communication instead of transcript marshaling.

### Decision Logic

```
if TeamsBridge.isAvailable() AND council_positions > 2:
  use Agent Teams mode (below)
else:
  use existing Task tool pattern (above)
```

### Teams Mode Flow

**Setup:**
1. Create team via `TeamsBridge.create({ teamName: 'council-debate-{topic}' })`
2. Spawn one member per council position with their role prompt and domain focus

**Round 1 - Positions (parallel):**
- Each member writes their initial position (same prompts as Step 2 above)
- Members write results to their own inbox as a "position" message

**Round 2 - Responses (parallel, after Round 1 completes):**
- Each member reads other members' inboxes directly (no transcript assembly needed)
- Members reference specific arguments from others' position messages
- Members write response to their own inbox

**Round 3 - Synthesis (parallel, after Round 2 completes):**
- Each member reads all inboxes (positions + responses) directly
- Members write final synthesis
- Lead reads all inboxes and assembles the synthesis output

**Cleanup:**
- `team.cleanup()` after synthesis is assembled

### Teams Mode Advantages

- **Direct reads**: Members read each other's inboxes instead of needing transcript marshaling by the lead
- **Reduced token overhead**: No need to paste full transcripts into each prompt
- **True parallelism**: Members run as independent Claude Code processes
- **Natural conversation**: Inbox messages preserve the conversational thread

### Teams Mode Output

Output format remains identical to the standard debate format (Rounds 1-3 + Council Synthesis). The difference is only in execution mechanics, not in what the user sees.

## Done

Debate complete. The transcript shows the full intellectual journey from initial positions through challenges to synthesis.
