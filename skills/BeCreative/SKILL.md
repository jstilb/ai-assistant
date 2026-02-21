---
name: BeCreative
description: Extended thinking mode. USE WHEN be creative, deep thinking, deep thinking, extended reasoning. SkillSearch('becreative') for docs.
---
## Voice Notification

**You MUST send this notification BEFORE doing anything else when this skill is invoked.**

1. **Send voice notification**:
   ```bash
   curl -s -X POST http://localhost:8888/notify \
     -H "Content-Type: application/json" \
     -d '{"message": "Running extended thinking in BeCreative with MODE mode"}' \
     > /dev/null 2>&1 &
   ```
   Replace MODE with the selected mode (Standard, Maximum, IdeaGeneration, TreeOfThoughts, DomainSpecific, or Technical).

2. **Output text notification**:
   ```
   Running **ExtendedThinking** in **BeCreative** with **MODE** mode...
   ```

**This is not optional. Execute this curl command immediately upon skill invocation.**

# BeCreative Skill

Enhance AI creativity using deep thinking + Verbalized Sampling. Combines research-backed techniques (Zhang et al., 2024) for 1.6-2.1x diversity increase and extended thinking for quality.

---

## Workflow Routing

All creative modes are consolidated into a single parameterized workflow. Load it and select the appropriate mode.

**Single workflow:** `Workflows/ExtendedThinking.md`

| Mode | Triggers | Description |
|------|----------|-------------|
| Standard | "be creative", "think creatively", default | Deep thinking + VS for quality creative work |
| Maximum | "maximum creativity", "most creative", "radically different" | Push boundaries, avoid cliches, unconventional |
| Idea Generation | "brainstorm", "ideas for", "solve this problem" | Problem-solving and innovation focus |
| Tree of Thoughts | "complex problem", "multi-factor", "explore paths" | Branching exploration for complex challenges |
| Domain-Specific | "artistic", "business innovation", domain-specific | Domain-tailored creativity (artistic or business) |
| Technical | "technical creativity", "algorithm", "architecture" | Engineering creativity via Gemini 3 Pro |

---

## Quick Reference

**Core technique:** Generate 5 diverse options (p<0.10 each) internally, output single best response.

**Default approach:** For most creative requests, use Standard mode.

**For artistic/narrative creativity:** Apply directly (no delegation needed).

**For technical creativity:** Use Technical mode (delegates to Gemini 3 Pro).

---

## Resource Index

| Resource | Description |
|----------|-------------|
| `ResearchFoundation.md` | Research backing, why it works, activation triggers |
| `Principles.md` | Core philosophy and best practices |
| `Templates.md` | Quick reference templates for all modes |
| `Examples.md` | Practical examples with expected outputs |
| `Assets/creative-writing-template.md` | Creative writing specific template |
| `Assets/idea-generation-template.md` | Brainstorming template |

---

## Integration with Other Skills

**Works well with:**
- **XPost** / **LinkedInPost** - Generate creative social media content
- **Blogging** - Creative blog post ideas and narrative approaches
- **Development** - Creative technical solutions
- **Art** - Diverse image prompt ideas and creative directions
- **Business** - Creative offer frameworks and business models
- **Research** - Creative research angles and synthesis approaches

---

## Examples

**Example 1: Creative blog angle**
```
User: "think outside the box for this AI ethics post"
-> ExtendedThinking workflow, Standard mode
-> Generates 5 diverse angles internally (p<0.10 each)
-> Returns most innovative framing approach
```

**Example 2: Product naming brainstorm**
```
User: "be creative - need names for this security tool"
-> ExtendedThinking workflow, Maximum mode
-> Explores unusual metaphors, domains, wordplay
-> Presents best option with reasoning
```

**Example 3: Technical creativity**
```
User: "deep thinking this architecture problem"
-> ExtendedThinking workflow, Technical mode
-> Uses Gemini 3 Pro for algorithmic creativity
-> Returns novel technical solution
```

---

**Research-backed creative enhancement: 1.6-2.1x diversity, 25.7% quality improvement.**
