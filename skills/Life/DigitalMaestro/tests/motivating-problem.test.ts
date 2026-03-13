import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const SKILL_ROOT = join(__dirname, '..')
const WORKFLOWS_DIR = join(SKILL_ROOT, 'Workflows')
const EXAMPLES_DIR = join(WORKFLOWS_DIR, 'Examples')
const TEMPLATES_DIR = join(WORKFLOWS_DIR, 'PromptTemplates')

// ISC 8772: MotivatingProblem.md exists with all 5 phases
describe('ISC-8772: MotivatingProblem.md structure', () => {
  const workflowPath = join(WORKFLOWS_DIR, 'MotivatingProblem.md')

  it('file exists at Workflows/MotivatingProblem.md', () => {
    expect(existsSync(workflowPath)).toBe(true)
  })

  it('contains all 5 phase headers', () => {
    const content = readFileSync(workflowPath, 'utf-8')
    expect(content).toMatch(/## Phase 1/i)
    expect(content).toMatch(/## Phase 2/i)
    expect(content).toMatch(/## Phase 3/i)
    expect(content).toMatch(/## Phase 4/i)
    expect(content).toMatch(/## Phase 5/i)
  })

  it('each phase has entry condition', () => {
    const content = readFileSync(workflowPath, 'utf-8')
    // Matches "**Entry condition:**" or "**Entry condition**"
    const entryConditionMatches = content.match(/\*\*Entry condition:\*\*/g) ?? []
    expect(entryConditionMatches.length).toBeGreaterThanOrEqual(5)
  })

  it('each phase has exit condition', () => {
    const content = readFileSync(workflowPath, 'utf-8')
    const exitConditionMatches = content.match(/\*\*Exit condition:\*\*/g) ?? []
    expect(exitConditionMatches.length).toBeGreaterThanOrEqual(5)
  })

  it('each phase has tone guidance', () => {
    const content = readFileSync(workflowPath, 'utf-8')
    const toneMatches = content.match(/\*\*Tone guidance:\*\*/g) ?? []
    expect(toneMatches.length).toBeGreaterThanOrEqual(5)
  })

  it('each phase has anti-patterns section', () => {
    const content = readFileSync(workflowPath, 'utf-8')
    const antiPatternMatches = content.match(/\*\*Anti-patterns to avoid:\*\*/g) ?? []
    expect(antiPatternMatches.length).toBeGreaterThanOrEqual(5)
  })
})

// ISC 4428: Quality checklist with >=5 items
describe('ISC-4428: Quality checklist', () => {
  it('Workflows/MotivatingProblem.md contains a Quality Checklist section', () => {
    const content = readFileSync(join(WORKFLOWS_DIR, 'MotivatingProblem.md'), 'utf-8')
    expect(content).toMatch(/## Quality Checklist/i)
  })

  it('quality checklist has at least 5 numbered items', () => {
    const content = readFileSync(join(WORKFLOWS_DIR, 'MotivatingProblem.md'), 'utf-8')
    // Find the Quality Checklist section
    const checklistSection = content.split(/## Quality Checklist/i)[1]
    expect(checklistSection).toBeDefined()
    // Count numbered list items (e.g., "1. **...**")
    const numberedItems = checklistSection.match(/^\d+\.\s+\*\*/gm) ?? []
    expect(numberedItems.length).toBeGreaterThanOrEqual(5)
  })

  it('checklist includes concept-name-absent check', () => {
    const content = readFileSync(join(WORKFLOWS_DIR, 'MotivatingProblem.md'), 'utf-8')
    expect(content.toLowerCase()).toMatch(/concept name absent/i)
  })

  it('checklist includes naive attempts check', () => {
    const content = readFileSync(join(WORKFLOWS_DIR, 'MotivatingProblem.md'), 'utf-8')
    expect(content).toMatch(/naive attempt/i)
  })

  it('checklist includes aha-moment-as-question check', () => {
    const content = readFileSync(join(WORKFLOWS_DIR, 'MotivatingProblem.md'), 'utf-8')
    expect(content).toMatch(/opens with a question|framed as question|open.{0,20}question/i)
  })
})

// ISC 8740: Two-layer prompt template
describe('ISC-8740: Two-layer prompt template', () => {
  const templatePath = join(TEMPLATES_DIR, 'MotivatingProblemPrompts.md')

  it('template file exists at Workflows/PromptTemplates/MotivatingProblemPrompts.md', () => {
    expect(existsSync(templatePath)).toBe(true)
  })

  it('contains Layer 1: Concept Analysis Prompt', () => {
    const content = readFileSync(templatePath, 'utf-8')
    expect(content).toMatch(/Layer 1.*Concept Analysis/i)
  })

  it('contains Layer 2: Narrative Generation Prompt', () => {
    const content = readFileSync(templatePath, 'utf-8')
    expect(content).toMatch(/Layer 2.*Narrative Generation/i)
  })

  it('Layer 1 produces structured output with required fields', () => {
    const content = readFileSync(templatePath, 'utf-8')
    expect(content).toMatch(/Core Problem Statement/i)
    expect(content).toMatch(/Naive Attempts/i)
    expect(content).toMatch(/Aha Moment|The Aha/i)
    expect(content).toMatch(/Formal Bridge/i)
  })

  it('Layer 2 takes Layer 1 output as input', () => {
    const content = readFileSync(templatePath, 'utf-8')
    expect(content).toMatch(/INSERT LAYER 1 OUTPUT|Layer 1 output/i)
  })
})

// ISC 7705: motivatingProblem pre-phase trigger condition
describe('ISC-7705: DigitalMaestro topic introduction flow integration', () => {
  it('MotivatingProblem.md defines the trigger condition', () => {
    const content = readFileSync(join(WORKFLOWS_DIR, 'MotivatingProblem.md'), 'utf-8')
    expect(content).toMatch(/isNewConcept/i)
    expect(content).toMatch(/conceptComplexity/i)
    expect(content).toMatch(/learnerRequestedDirect/i)
  })

  it('trigger condition includes MODERATE threshold', () => {
    const content = readFileSync(join(WORKFLOWS_DIR, 'MotivatingProblem.md'), 'utf-8')
    expect(content).toMatch(/MODERATE/i)
  })

  it('SKILL.md routing table includes MotivatingProblem entry', () => {
    const skillContent = readFileSync(join(SKILL_ROOT, 'SKILL.md'), 'utf-8')
    expect(skillContent).toMatch(/MotivatingProblem/i)
  })

  it('existing workflows in SKILL.md are unmodified (NewSession, ReviewOnly, PracticeOnly, ProgressReport, ConceptIntro)', () => {
    const skillContent = readFileSync(join(SKILL_ROOT, 'SKILL.md'), 'utf-8')
    expect(skillContent).toMatch(/NewSession/)
    expect(skillContent).toMatch(/ReviewOnly/)
    expect(skillContent).toMatch(/PracticeOnly/)
    expect(skillContent).toMatch(/ProgressReport/)
    expect(skillContent).toMatch(/ConceptIntro/)
  })
})

// ISC 4998: Three STEM example problems
describe('ISC-4998: STEM example motivating problems', () => {
  it('calculus example exists', () => {
    expect(existsSync(join(EXAMPLES_DIR, 'calculus-area-under-curves.md'))).toBe(true)
  })

  it('linear algebra example exists', () => {
    expect(existsSync(join(EXAMPLES_DIR, 'linear-algebra-systems-of-equations.md'))).toBe(true)
  })

  it('Fourier transforms example exists', () => {
    expect(existsSync(join(EXAMPLES_DIR, 'fourier-transforms-signal-decomposition.md'))).toBe(true)
  })

  it('each example has at least 2 concrete naive attempts with specific numbers', () => {
    const examples = [
      'calculus-area-under-curves.md',
      'linear-algebra-systems-of-equations.md',
      'fourier-transforms-signal-decomposition.md',
    ]
    for (const example of examples) {
      const content = readFileSync(join(EXAMPLES_DIR, example), 'utf-8')
      // Check for Attempt 1 and Attempt 2 headers
      const attemptMatches = content.match(/\*\*Attempt \d/g) ?? []
      expect(attemptMatches.length).toBeGreaterThanOrEqual(2)
      // Check for specific numbers (digits in the content)
      const numberMatches = content.match(/\$[\d,]+|\d+\.\d+|\d+ (miles|square|Hz|strips)/g) ?? []
      expect(numberMatches.length).toBeGreaterThan(0)
    }
  })

  it('concept name is absent from PHASE 1 and PHASE 2 narrative in each STEM example', () => {
    const examples = [
      // Only check Phase 1 and Phase 2 — frontmatter "forbidden terms" list is metadata
      { file: 'calculus-area-under-curves.md', forbidden: ['integral', 'integration', 'antiderivative'] },
      { file: 'linear-algebra-systems-of-equations.md', forbidden: ['system of equations', 'elimination method', 'substitution method'] },
      { file: 'fourier-transforms-signal-decomposition.md', forbidden: ['fourier', 'frequency domain', 'spectrum'] },
    ]
    for (const { file, forbidden } of examples) {
      const content = readFileSync(join(EXAMPLES_DIR, file), 'utf-8')
      // Extract only Phase 1 and Phase 2 narrative sections (skip frontmatter and headers)
      const phase1Match = content.match(/## PHASE 1[^#]*## PHASE 2/is)
      const phase2Match = content.match(/## PHASE 2[^#]*## PHASE 3/is)
      const narrativeContent = ((phase1Match?.[0] ?? '') + (phase2Match?.[0] ?? '')).toLowerCase()
      for (const term of forbidden) {
        expect(narrativeContent).not.toContain(term.toLowerCase())
      }
    }
  })

  it('Phase 3 aha moment is framed as a question in each example', () => {
    const examples = [
      'calculus-area-under-curves.md',
      'linear-algebra-systems-of-equations.md',
      'fourier-transforms-signal-decomposition.md',
    ]
    for (const example of examples) {
      const content = readFileSync(join(EXAMPLES_DIR, example), 'utf-8')
      // Find Phase 3 section
      const phase3Section = content.split(/## PHASE 3/i)[1]?.split(/## PHASE 4/i)[0] ?? ''
      // Phase 3 must contain a sentence ending with ?
      expect(phase3Section).toMatch(/\?/)
    }
  })
})

// ISC 2456: Non-STEM example
describe('ISC-2456: Non-STEM example motivating problem', () => {
  it('music theory notation example exists', () => {
    expect(existsSync(join(EXAMPLES_DIR, 'music-theory-notation.md'))).toBe(true)
  })

  it('non-STEM example follows same 5-phase structure', () => {
    const content = readFileSync(join(EXAMPLES_DIR, 'music-theory-notation.md'), 'utf-8')
    expect(content).toMatch(/## PHASE 1/i)
    expect(content).toMatch(/## PHASE 2/i)
    expect(content).toMatch(/## PHASE 3/i)
    expect(content).toMatch(/## PHASE 4/i)
    expect(content).toMatch(/## PHASE 5/i)
  })

  it('concept name withheld until Phase 4 in non-STEM example narrative (not metadata)', () => {
    const content = readFileSync(join(EXAMPLES_DIR, 'music-theory-notation.md'), 'utf-8')
    // Extract Phase 1, 2, 3 narrative only (not frontmatter)
    const phase1Match = content.match(/## PHASE 1[^#]*## PHASE 2/is)
    const phase2Match = content.match(/## PHASE 2[^#]*## PHASE 3/is)
    const phase3Match = content.match(/## PHASE 3[^#]*## PHASE 4/is)
    const earlyNarrative = ((phase1Match?.[0] ?? '') + (phase2Match?.[0] ?? '') + (phase3Match?.[0] ?? '')).toLowerCase()
    // "sheet music" is a synonym that should be absent
    expect(earlyNarrative).not.toContain('sheet music')
    // "notation" should be withheld until Phase 4 in the narrative
    expect(earlyNarrative).not.toContain('notation')
  })

  it('non-STEM example has at least 2 concrete naive attempts', () => {
    const content = readFileSync(join(EXAMPLES_DIR, 'music-theory-notation.md'), 'utf-8')
    const attemptMatches = content.match(/\*\*Attempt \d/g) ?? []
    expect(attemptMatches.length).toBeGreaterThanOrEqual(2)
  })
})

// ISC 1400: Escape hatch
describe('ISC-1400: Escape hatch', () => {
  it('MotivatingProblem.md has an Escape Hatch section', () => {
    const content = readFileSync(join(WORKFLOWS_DIR, 'MotivatingProblem.md'), 'utf-8')
    expect(content).toMatch(/## Escape Hatch/i)
  })

  it('escape hatch defines trigger phrases', () => {
    const content = readFileSync(join(WORKFLOWS_DIR, 'MotivatingProblem.md'), 'utf-8')
    expect(content).toMatch(/just tell me/i)
    expect(content).toMatch(/skip/i)
  })

  it('escape hatch targets Phase 4-5 without directing learner to restart', () => {
    const content = readFileSync(join(WORKFLOWS_DIR, 'MotivatingProblem.md'), 'utf-8')
    const escapeSection = content.split(/## Escape Hatch/i)[1] ?? ''
    expect(escapeSection).toMatch(/Phase 4/i)
    expect(escapeSection).toMatch(/Phase 5/i)
    // The escape hatch should NOT tell the learner to restart (it may say "do NOT restart" which is correct)
    // We check that the escape hatch doesn't instruct the learner to go back to Phase 1
    expect(escapeSection).not.toMatch(/go back to Phase 1|return to Phase 1|start over from Phase 1/i)
  })
})

// ISC 1106: SKILL.md routing updated
describe('ISC-1106: SKILL.md Workflow Routing updated', () => {
  it('SKILL.md contains MotivatingProblem in workflow routing table', () => {
    const content = readFileSync(join(SKILL_ROOT, 'SKILL.md'), 'utf-8')
    expect(content).toMatch(/MotivatingProblem/)
  })

  it('SKILL.md MotivatingProblem entry has USE WHEN trigger', () => {
    const content = readFileSync(join(SKILL_ROOT, 'SKILL.md'), 'utf-8')
    // Find the row in the routing table containing MotivatingProblem
    const routingTableLine = content.split('\n').find(line => line.includes('MotivatingProblem'))
    expect(routingTableLine).toBeDefined()
    expect(routingTableLine?.toLowerCase()).toMatch(/use when/i)
  })
})
