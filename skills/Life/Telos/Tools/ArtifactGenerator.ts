#!/usr/bin/env bun
/**
 * ArtifactGenerator - Generate JSON artifacts from TELOS markdown files
 *
 * This tool parses TELOS markdown files and generates the 5 JSON artifacts
 * required by the WriteReport workflow:
 * - findings.json - Extracted from PROBLEMS, CRITICAL_ISSUES, BLOCKERS
 * - recommendations.json - From STRATEGIES, narrative requirements
 * - roadmap.json - From ROADMAP/TIMELINE or generates defaults
 * - methodology.json - Interview counts and roles
 * - narrative.json - Full narrative structure for report
 *
 * Usage:
 *   bun ArtifactGenerator.ts <source_dir> [--narrative <file>] [--output <dir>]
 *
 * Example:
 *   bun ArtifactGenerator.ts ~/.claude/USER/TELOS --output /tmp/artifacts
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, basename } from 'path';

// Types for artifacts
interface Finding {
  id: string;
  title: string;
  description: string;
  evidence: string;
  source: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

interface Recommendation {
  id: string;
  title: string;
  description: string;
  priority: 'immediate' | 'short-term' | 'long-term';
}

interface Phase {
  phase: string;
  title: string;
  description: string;
  duration: string;
}

interface Methodology {
  interviewCount: number;
  roles: string[];
}

interface Narrative {
  context: string;
  clientAsk: string;
  currentState: string;
  whyNow: string;
  existentialRisks: string[];
  competitiveThreats: string[];
  timelinePressures: string;
  goodNews: string;
  requirements: string[];
  targetStateDescription: string;
  keyCapabilities: string[];
  successMetrics: string[];
  immediateSteps: string[];
  decisionPoints: string[];
  commitmentRequired: string;
}

// Parse command line arguments
function parseArgs(): { sourceDir: string; narrativeFile?: string; outputDir: string } {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: bun ArtifactGenerator.ts <source_dir> [--narrative <file>] [--output <dir>]');
    process.exit(1);
  }

  const sourceDir = args[0];
  let narrativeFile: string | undefined;
  let outputDir = join(sourceDir, 'artifacts');

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--narrative' && args[i + 1]) {
      narrativeFile = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      outputDir = args[++i];
    }
  }

  return { sourceDir, narrativeFile, outputDir };
}

// Read a markdown file and return its content
function readMarkdownFile(dir: string, filename: string): string {
  const filepath = join(dir, filename);
  if (existsSync(filepath)) {
    return readFileSync(filepath, 'utf-8');
  }
  return '';
}

// Extract bullet points from markdown content
function extractBulletPoints(content: string): string[] {
  const lines = content.split('\n');
  const points: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      points.push(trimmed.slice(2).trim());
    } else if (/^\d+\.\s/.test(trimmed)) {
      points.push(trimmed.replace(/^\d+\.\s*/, '').trim());
    }
  }

  return points;
}

// Extract sections from markdown (## Section Name)
function extractSections(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = content.split('\n');
  let currentSection = '';
  let currentContent: string[] = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (currentSection) {
        sections.set(currentSection.toLowerCase(), currentContent.join('\n').trim());
      }
      currentSection = line.slice(3).trim();
      currentContent = [];
    } else if (currentSection) {
      currentContent.push(line);
    }
  }

  if (currentSection) {
    sections.set(currentSection.toLowerCase(), currentContent.join('\n').trim());
  }

  return sections;
}

// Determine severity based on content keywords
function determineSeverity(text: string): 'critical' | 'high' | 'medium' | 'low' {
  const lower = text.toLowerCase();
  if (lower.includes('critical') || lower.includes('urgent') || lower.includes('immediate')) {
    return 'critical';
  }
  if (lower.includes('high') || lower.includes('important') || lower.includes('significant')) {
    return 'high';
  }
  if (lower.includes('low') || lower.includes('minor')) {
    return 'low';
  }
  return 'medium';
}

// Determine priority based on content keywords
function determinePriority(text: string): 'immediate' | 'short-term' | 'long-term' {
  const lower = text.toLowerCase();
  if (lower.includes('immediate') || lower.includes('urgent') || lower.includes('now')) {
    return 'immediate';
  }
  if (lower.includes('long-term') || lower.includes('future') || lower.includes('eventually')) {
    return 'long-term';
  }
  return 'short-term';
}

// Generate findings from TELOS files
function generateFindings(sourceDir: string): Finding[] {
  const findings: Finding[] = [];
  let findingId = 1;

  // Check for PROBLEMS.md, CHALLENGES.md, BLOCKERS.md
  const problemFiles = ['PROBLEMS.md', 'CHALLENGES.md', 'BLOCKERS.md', 'CRITICAL_ISSUES.md'];

  for (const filename of problemFiles) {
    const content = readMarkdownFile(sourceDir, filename);
    if (!content) continue;

    const points = extractBulletPoints(content);
    const sourceType = basename(filename, '.md').toLowerCase();

    for (const point of points) {
      if (point.length < 10) continue; // Skip very short entries

      findings.push({
        id: `F${findingId++}`,
        title: point.length > 80 ? point.slice(0, 77) + '...' : point,
        description: point,
        evidence: `Identified in ${sourceType} analysis`,
        source: `${sourceType} assessment`,
        severity: determineSeverity(point),
      });
    }
  }

  // If no findings from specific files, try to extract from TELOS.md
  if (findings.length === 0) {
    const telosContent = readMarkdownFile(sourceDir, 'TELOS.md');
    if (telosContent) {
      const sections = extractSections(telosContent);
      const problemSection = sections.get('problems') || sections.get('challenges') || sections.get('issues');

      if (problemSection) {
        const points = extractBulletPoints(problemSection);
        for (const point of points) {
          if (point.length < 10) continue;

          findings.push({
            id: `F${findingId++}`,
            title: point.length > 80 ? point.slice(0, 77) + '...' : point,
            description: point,
            evidence: 'Identified in TELOS analysis',
            source: 'TELOS assessment',
            severity: determineSeverity(point),
          });
        }
      }
    }
  }

  return findings;
}

// Generate recommendations from STRATEGIES and other files
function generateRecommendations(sourceDir: string): Recommendation[] {
  const recommendations: Recommendation[] = [];
  let recId = 1;

  const strategyFiles = ['STRATEGIES.md', 'SOLUTIONS.md', 'RECOMMENDATIONS.md', 'ACTIONS.md'];

  for (const filename of strategyFiles) {
    const content = readMarkdownFile(sourceDir, filename);
    if (!content) continue;

    const points = extractBulletPoints(content);

    for (const point of points) {
      if (point.length < 10) continue;

      recommendations.push({
        id: `R${recId++}`,
        title: point.length > 80 ? point.slice(0, 77) + '...' : point,
        description: point,
        priority: determinePriority(point),
      });
    }
  }

  // Fallback: extract from GOALS.md if no strategies found
  if (recommendations.length === 0) {
    const goalsContent = readMarkdownFile(sourceDir, 'GOALS.md');
    if (goalsContent) {
      const points = extractBulletPoints(goalsContent);
      for (const point of points.slice(0, 10)) { // Limit to 10
        if (point.length < 10) continue;

        recommendations.push({
          id: `R${recId++}`,
          title: point.length > 80 ? point.slice(0, 77) + '...' : point,
          description: point,
          priority: determinePriority(point),
        });
      }
    }
  }

  return recommendations;
}

// Generate roadmap from ROADMAP.md or create default phases
function generateRoadmap(sourceDir: string): Phase[] {
  const roadmapContent = readMarkdownFile(sourceDir, 'ROADMAP.md') ||
                         readMarkdownFile(sourceDir, 'TIMELINE.md');

  if (roadmapContent) {
    const sections = extractSections(roadmapContent);
    const phases: Phase[] = [];
    let phaseNum = 1;

    for (const [sectionName, content] of sections) {
      if (sectionName.includes('phase') || /^\d+/.test(sectionName)) {
        phases.push({
          phase: `Phase ${phaseNum}`,
          title: sectionName.charAt(0).toUpperCase() + sectionName.slice(1),
          description: content.split('\n')[0] || content.slice(0, 200),
          duration: `Weeks ${(phaseNum - 1) * 4 + 1}-${phaseNum * 4}`,
        });
        phaseNum++;
      }
    }

    if (phases.length > 0) return phases;
  }

  // Generate default 3-phase roadmap
  return [
    {
      phase: 'Phase 1',
      title: 'Foundation & Quick Wins',
      description: 'Establish baseline, address critical issues, implement immediate improvements',
      duration: 'Weeks 1-4',
    },
    {
      phase: 'Phase 2',
      title: 'Core Implementation',
      description: 'Build core capabilities, integrate systems, develop key features',
      duration: 'Weeks 5-12',
    },
    {
      phase: 'Phase 3',
      title: 'Optimization & Scale',
      description: 'Refine processes, scale solutions, measure and iterate',
      duration: 'Weeks 13-20',
    },
  ];
}

// Generate methodology (placeholder - customize based on actual interview data)
function generateMethodology(sourceDir: string): Methodology {
  // Look for interview or methodology files
  const methodFiles = ['METHODOLOGY.md', 'INTERVIEWS.md', 'SOURCES.md'];

  for (const filename of methodFiles) {
    const content = readMarkdownFile(sourceDir, filename);
    if (!content) continue;

    const points = extractBulletPoints(content);
    const roles = points.filter(p =>
      p.toLowerCase().includes('ceo') ||
      p.toLowerCase().includes('cto') ||
      p.toLowerCase().includes('vp') ||
      p.toLowerCase().includes('director') ||
      p.toLowerCase().includes('manager') ||
      p.toLowerCase().includes('lead')
    );

    if (roles.length > 0) {
      return {
        interviewCount: roles.length,
        roles: roles.slice(0, 10),
      };
    }
  }

  // Default methodology
  return {
    interviewCount: 0,
    roles: ['Document analysis', 'System review', 'Pattern assessment'],
  };
}

// Generate narrative structure
function generateNarrative(sourceDir: string, narrativeFile?: string): Narrative {
  // If narrative file provided, try to parse it
  if (narrativeFile && existsSync(narrativeFile)) {
    const content = readFileSync(narrativeFile, 'utf-8');
    const sections = extractSections(content);

    return {
      context: sections.get('context') || sections.get('overview') || '',
      clientAsk: sections.get('client ask') || sections.get('request') || '',
      currentState: sections.get('current state') || sections.get('situation') || '',
      whyNow: sections.get('why now') || sections.get('urgency') || '',
      existentialRisks: extractBulletPoints(sections.get('risks') || sections.get('existential risks') || ''),
      competitiveThreats: extractBulletPoints(sections.get('competitive threats') || sections.get('threats') || ''),
      timelinePressures: sections.get('timeline') || sections.get('timeline pressures') || '',
      goodNews: sections.get('good news') || sections.get('opportunity') || '',
      requirements: extractBulletPoints(sections.get('requirements') || ''),
      targetStateDescription: sections.get('target state') || sections.get('vision') || '',
      keyCapabilities: extractBulletPoints(sections.get('capabilities') || sections.get('key capabilities') || ''),
      successMetrics: extractBulletPoints(sections.get('metrics') || sections.get('success metrics') || ''),
      immediateSteps: extractBulletPoints(sections.get('immediate steps') || sections.get('next steps') || ''),
      decisionPoints: extractBulletPoints(sections.get('decisions') || sections.get('decision points') || ''),
      commitmentRequired: sections.get('commitment') || sections.get('commitment required') || '',
    };
  }

  // Build narrative from TELOS files
  const missionContent = readMarkdownFile(sourceDir, 'MISSION.md');
  const goalsContent = readMarkdownFile(sourceDir, 'GOALS.md');
  const problemsContent = readMarkdownFile(sourceDir, 'PROBLEMS.md');
  const strategiesContent = readMarkdownFile(sourceDir, 'STRATEGIES.md');
  const visionContent = readMarkdownFile(sourceDir, 'VISION.md');

  const goals = extractBulletPoints(goalsContent);
  const problems = extractBulletPoints(problemsContent);
  const strategies = extractBulletPoints(strategiesContent);

  return {
    context: missionContent.split('\n').slice(0, 3).join(' ').trim() ||
             'Strategic assessment and transformation roadmap',
    clientAsk: goals[0] || 'Comprehensive analysis and actionable recommendations',
    currentState: problems.slice(0, 2).join('. ') || 'Multiple challenges require strategic intervention',
    whyNow: 'Market conditions and competitive pressures demand immediate action',
    existentialRisks: problems.filter(p => determineSeverity(p) === 'critical').slice(0, 3),
    competitiveThreats: problems.filter(p =>
      p.toLowerCase().includes('compet') ||
      p.toLowerCase().includes('market') ||
      p.toLowerCase().includes('rival')
    ).slice(0, 3),
    timelinePressures: 'Time-sensitive opportunity window requiring decisive action',
    goodNews: strategies[0] || 'Clear path forward exists with proper execution',
    requirements: strategies.slice(0, 5),
    targetStateDescription: visionContent.split('\n').slice(0, 3).join(' ').trim() ||
                           goals.slice(0, 3).join('. '),
    keyCapabilities: strategies.slice(0, 4),
    successMetrics: goals.filter(g =>
      g.includes('%') ||
      g.includes('increase') ||
      g.includes('decrease') ||
      g.includes('improve')
    ).slice(0, 4),
    immediateSteps: strategies.slice(0, 3),
    decisionPoints: [
      'Resource allocation for implementation',
      'Timeline commitment',
      'Organizational alignment',
    ],
    commitmentRequired: 'Full organizational commitment to transformation agenda',
  };
}

// Main execution
async function main() {
  const { sourceDir, narrativeFile, outputDir } = parseArgs();

  // Validate source directory
  if (!existsSync(sourceDir)) {
    console.error(`❌ Source directory not found: ${sourceDir}`);
    process.exit(1);
  }

  // Create output directory
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  console.log(`📁 Source: ${sourceDir}`);
  console.log(`📂 Output: ${outputDir}`);
  if (narrativeFile) {
    console.log(`📝 Narrative: ${narrativeFile}`);
  }
  console.log('');

  // List available source files
  const files = readdirSync(sourceDir).filter(f => f.endsWith('.md'));
  console.log(`📄 Found ${files.length} markdown files:`);
  files.forEach(f => console.log(`   - ${f}`));
  console.log('');

  // Generate artifacts
  console.log('🔄 Generating artifacts...\n');

  const findings = generateFindings(sourceDir);
  console.log(`✅ findings.json (${findings.length} findings)`);
  writeFileSync(
    join(outputDir, 'findings.json'),
    JSON.stringify({ findings }, null, 2)
  );

  const recommendations = generateRecommendations(sourceDir);
  console.log(`✅ recommendations.json (${recommendations.length} recommendations)`);
  writeFileSync(
    join(outputDir, 'recommendations.json'),
    JSON.stringify({ recommendations }, null, 2)
  );

  const roadmap = generateRoadmap(sourceDir);
  console.log(`✅ roadmap.json (${roadmap.length} phases)`);
  writeFileSync(
    join(outputDir, 'roadmap.json'),
    JSON.stringify({ phases: roadmap }, null, 2)
  );

  const methodology = generateMethodology(sourceDir);
  console.log(`✅ methodology.json (${methodology.interviewCount} interviews, ${methodology.roles.length} roles)`);
  writeFileSync(
    join(outputDir, 'methodology.json'),
    JSON.stringify(methodology, null, 2)
  );

  const narrative = generateNarrative(sourceDir, narrativeFile);
  const narrativeFields = Object.entries(narrative).filter(([_, v]) =>
    (typeof v === 'string' && v.length > 0) ||
    (Array.isArray(v) && v.length > 0)
  ).length;
  console.log(`✅ narrative.json (${narrativeFields} populated fields)`);
  writeFileSync(
    join(outputDir, 'narrative.json'),
    JSON.stringify(narrative, null, 2)
  );

  console.log('\n🎯 Artifact generation complete!');
  console.log(`\n📦 Files created in: ${outputDir}`);
  console.log('   - findings.json');
  console.log('   - recommendations.json');
  console.log('   - roadmap.json');
  console.log('   - methodology.json');
  console.log('   - narrative.json');
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
