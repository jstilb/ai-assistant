#!/usr/bin/env bun
/**
 * ArtBridge.ts
 *
 * Interface to Art skill for PNG diagram generation.
 * Converts Mermaid diagrams to professional visual diagrams via Art/Tools/Generate.ts.
 *
 * Usage:
 *   bun ArtBridge.ts generate --diagram overview --output ~/Downloads/overview.png
 *   bun ArtBridge.ts generate --title "Kaya Architecture" --content "..." --output ~/Downloads/arch.png
 *   bun ArtBridge.ts batch --input markdown/ --output images/
 */

import { $ } from 'bun';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { join, basename } from 'path';
import { existsSync } from 'fs';
import { generateAllDiagrams, type DiagramOutput, type DiagramSet } from './DiagramBuilder.ts';

const KAYA_DIR = process.env.KAYA_DIR || process.env.KAYA_HOME || join(process.env.HOME || '', '.claude');
const ART_GENERATE = join(KAYA_DIR, 'skills', 'Art', 'Tools', 'Generate.ts');

// ============================================================================
// Types
// ============================================================================

export interface GenerateOptions {
  model?: 'nano-banana' | 'nano-banana-pro' | 'flux';
  size?: '1K' | '2K' | '4K';
  aspectRatio?: '16:9' | '1:1' | '21:9' | '3:2';
  output: string;
}

export interface DiagramGenerateOptions extends GenerateOptions {
  title: string;
  subtitle?: string;
  diagramContent: string;
}

// ============================================================================
// Prompt Building
// ============================================================================

/**
 * Build a technical diagram prompt following Art/Workflows/TechnicalDiagrams.md style
 */
function buildTechnicalDiagramPrompt(options: {
  title: string;
  subtitle?: string;
  diagramDescription: string;
  elements: string[];
}): string {
  const { title, subtitle, diagramDescription, elements } = options;

  return `Create a clean Excalidraw-style technical diagram on pure black #000000 background.

STYLE: Architect aesthetic — professional, approachable, hand-drawn quality like an elite architect's whiteboard.

TYPOGRAPHY:
- HEADER: Elegant wedge-serif italic font, large size, white color, top-left position. Text: "${title}"
${subtitle ? `- SUBTITLE: Same wedge-serif regular weight, smaller size, light gray #CCCCCC color, below header. Text: "${subtitle}"` : ''}
- LABELS: Geometric sans-serif font (Avenir-style), medium size, white color, for all component names
- INSIGHTS: Condensed italic sans-serif, smaller size, Purple #4A148C or Teal #00796B, with asterisks like "*key insight*"

DIAGRAM CONTENT:
${diagramDescription}

ELEMENTS TO INCLUDE:
${elements.map(e => `- ${e}`).join('\n')}

COLOR PALETTE:
- Background: Pure black #000000
- Primary boxes/nodes: White outlines, dark fills
- Accent (key components): Purple #4A148C
- Flows/connections: Teal #00796B
- Text: White/light gray

Include 2-3 insight callouts with asterisks in the condensed italic style.

The whole image should look hand-drawn by an extremely talented architect-artist, like Excalidraw but more stylish and professional.`;
}

/**
 * Parse a Mermaid diagram and extract its structure
 */
function parseMermaidDiagram(mermaid: string): {
  type: string;
  subgraphs: string[];
  nodes: string[];
  connections: string[];
} {
  const lines = mermaid.split('\n');
  const subgraphs: string[] = [];
  const nodes: string[] = [];
  const connections: string[] = [];
  let type = 'flowchart';

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect diagram type
    if (trimmed.startsWith('flowchart') || trimmed.startsWith('graph')) {
      type = 'flowchart';
    } else if (trimmed.startsWith('sequenceDiagram')) {
      type = 'sequence';
    }

    // Extract subgraph titles
    const subgraphMatch = trimmed.match(/subgraph\s+(\w+)\["([^"]+)"\]/);
    if (subgraphMatch) {
      subgraphs.push(subgraphMatch[2]);
    }

    // Extract nodes
    const nodeMatch = trimmed.match(/(\w+)\["([^"]+)"\]/);
    if (nodeMatch && !trimmed.startsWith('subgraph')) {
      nodes.push(nodeMatch[2]);
    }

    // Extract connections
    if (trimmed.includes('-->') || trimmed.includes('->>')) {
      connections.push(trimmed.replace(/-->|->>/g, '→'));
    }
  }

  return { type, subgraphs, nodes, connections };
}

// ============================================================================
// Generation Functions
// ============================================================================

/**
 * Generate a PNG diagram using Art skill's Generate.ts
 */
export async function generateDiagram(options: DiagramGenerateOptions): Promise<string> {
  const { title, subtitle, diagramContent, output, model = 'nano-banana-pro', size = '2K', aspectRatio = '16:9' } = options;

  // Parse the Mermaid content
  const parsed = parseMermaidDiagram(diagramContent);

  // Build the prompt
  const prompt = buildTechnicalDiagramPrompt({
    title,
    subtitle,
    diagramDescription: `A ${parsed.type} diagram showing the Kaya system architecture.`,
    elements: [
      ...parsed.subgraphs.map(s => `Section: ${s}`),
      ...parsed.nodes.slice(0, 10).map(n => `Component: ${n}`),
      ...(parsed.connections.length > 0 ? [`Key relationships: ${parsed.connections.slice(0, 5).join(', ')}`] : []),
    ],
  });

  console.log(`🎨 Generating diagram: ${title}`);
  console.log(`   Model: ${model}, Size: ${size}, Aspect: ${aspectRatio}`);
  console.log(`   Output: ${output}`);

  // Call Art skill's Generate.ts
  try {
    await $`bun ${ART_GENERATE} \
      --model ${model} \
      --prompt ${prompt} \
      --size ${size} \
      --aspect-ratio ${aspectRatio} \
      --output ${output}`;

    console.log(`✅ Generated: ${output}`);
    return output;
  } catch (error) {
    console.error(`❌ Failed to generate diagram: ${error}`);
    throw error;
  }
}

/**
 * Generate PNG for a pre-built DiagramOutput
 */
export async function generateFromDiagramOutput(
  diagram: DiagramOutput,
  outputDir: string,
  options?: Partial<GenerateOptions>
): Promise<string> {
  const outputPath = join(outputDir, `${diagram.name}.png`);

  // Extract title from name
  const title = diagram.name
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  return generateDiagram({
    title,
    subtitle: diagram.description,
    diagramContent: diagram.mermaid,
    output: outputPath,
    model: options?.model || 'nano-banana-pro',
    size: options?.size || '2K',
    aspectRatio: options?.aspectRatio || '16:9',
  });
}

/**
 * Generate all diagrams as PNGs
 */
export async function generateAllPNGs(outputDir: string): Promise<string[]> {
  const diagramSet = await generateAllDiagrams();

  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true });
  }

  const generated: string[] = [];

  for (const diagram of diagramSet.diagrams) {
    try {
      const path = await generateFromDiagramOutput(diagram, outputDir);
      generated.push(path);
    } catch (error) {
      console.error(`Failed to generate ${diagram.name}:`, error);
    }
  }

  return generated;
}

/**
 * Convert markdown files with Mermaid diagrams to PNGs
 */
export async function batchConvert(inputDir: string, outputDir: string): Promise<string[]> {
  if (!existsSync(inputDir)) {
    throw new Error(`Input directory not found: ${inputDir}`);
  }

  if (!existsSync(outputDir)) {
    await mkdir(outputDir, { recursive: true });
  }

  const files = await readdir(inputDir);
  const mdFiles = files.filter(f => f.endsWith('.md'));
  const generated: string[] = [];

  for (const file of mdFiles) {
    const content = await readFile(join(inputDir, file), 'utf-8');

    // Extract title from first heading
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch?.[1] || basename(file, '.md');

    // Extract description (first paragraph after title)
    const descMatch = content.match(/^#\s+.+\n\n(.+)$/m);
    const subtitle = descMatch?.[1];

    // Extract Mermaid content
    const mermaidMatch = content.match(/```mermaid\n([\s\S]+?)\n```/);
    if (!mermaidMatch) {
      console.log(`No Mermaid diagram found in ${file}, skipping`);
      continue;
    }

    const outputPath = join(outputDir, basename(file, '.md') + '.png');

    try {
      await generateDiagram({
        title,
        subtitle,
        diagramContent: mermaidMatch[1],
        output: outputPath,
      });
      generated.push(outputPath);
    } catch (error) {
      console.error(`Failed to convert ${file}:`, error);
    }
  }

  return generated;
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(`
ArtBridge - Generate PNG Diagrams via Art Skill

Usage:
  bun ArtBridge.ts generate --title "Title" --content "mermaid..." --output path.png
  bun ArtBridge.ts batch --input markdown/ --output images/
  bun ArtBridge.ts all --output images/

Commands:
  generate    Generate a single diagram PNG
  batch       Convert all markdown files in a directory to PNGs
  all         Generate all Kaya architecture diagrams as PNGs

Options:
  --title       Diagram title
  --subtitle    Optional subtitle
  --content     Mermaid diagram content (or --file for file)
  --file        Read Mermaid content from file
  --input       Input directory for batch mode
  --output      Output path/directory
  --model       Model: nano-banana, nano-banana-pro (default), flux
  --size        Size: 1K, 2K (default), 4K
  --aspect-ratio Aspect ratio: 16:9 (default), 1:1, 21:9, 3:2
`);
    return;
  }

  // Parse common options
  const getArg = (name: string): string | undefined => {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  switch (command) {
    case 'generate': {
      const title = getArg('title');
      const subtitle = getArg('subtitle');
      const content = getArg('content');
      const file = getArg('file');
      const output = getArg('output');
      const model = getArg('model') as GenerateOptions['model'];
      const size = getArg('size') as GenerateOptions['size'];
      const aspectRatio = getArg('aspect-ratio') as GenerateOptions['aspectRatio'];

      if (!title || !output) {
        console.error('Required: --title and --output');
        process.exit(1);
      }

      let diagramContent = content;
      if (file) {
        diagramContent = await readFile(file, 'utf-8');
      }

      if (!diagramContent) {
        console.error('Required: --content or --file');
        process.exit(1);
      }

      await generateDiagram({
        title,
        subtitle,
        diagramContent,
        output,
        model,
        size,
        aspectRatio,
      });
      break;
    }

    case 'batch': {
      const input = getArg('input');
      const output = getArg('output');

      if (!input || !output) {
        console.error('Required: --input and --output');
        process.exit(1);
      }

      const generated = await batchConvert(input, output);
      console.log(`\nGenerated ${generated.length} PNG diagrams`);
      break;
    }

    case 'all': {
      const output = getArg('output') || join(KAYA_DIR, 'skills', 'SystemFlowchart', 'Output', 'images');
      const generated = await generateAllPNGs(output);
      console.log(`\nGenerated ${generated.length} PNG diagrams to ${output}`);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

main().catch(console.error);
