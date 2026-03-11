#!/usr/bin/env bun
/**
 * SessionIngester - Parse MEMORY/WORK/ session directories into graph nodes
 *
 * Creates session nodes from work directories, extracts error nodes
 * from session content, creates file nodes from file modifications,
 * and links them together.
 *
 * @module Graph/SessionIngester
 * @version 1.0.0
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { GraphNode, GraphEdge, IngestionResult } from '../types';
import { createNode, createEdge } from '../types';
import { GraphPersistence, getGraphPersistence } from '../GraphPersistence';

// ============================================
// CONSTANTS
// ============================================

const KAYA_HOME = join(homedir(), '.claude');
const WORK_DIR = join(KAYA_HOME, 'MEMORY', 'WORK');

// ============================================
// ERROR PATTERNS
// ============================================

const ERROR_PATTERNS = [
  /Error:\s*(.+)/i,
  /TypeError:\s*(.+)/i,
  /ReferenceError:\s*(.+)/i,
  /SyntaxError:\s*(.+)/i,
  /RangeError:\s*(.+)/i,
  /ENOENT:\s*(.+)/i,
  /EACCES:\s*(.+)/i,
  /EPERM:\s*(.+)/i,
  /fatal:\s*(.+)/i,
  /panic:\s*(.+)/i,
  /FAIL\s+(.+)/i,
  /api.error.*?(\d{3})\s*(.+)/i,
];

// ============================================
// FILE REFERENCE PATTERNS
// ============================================

const FILE_PATTERNS = [
  /(?:^|\s)((?:skills|tools|MEMORY|hooks)\/[\w\-\.\/]+\.\w+)/g,
  /(?:modified|changed|created|deleted|editing)\s+[`"]?([\w\-\.\/]+\.\w+)[`"]?/gi,
  /(?:File|file):\s*[`"]?([\w\-\.\/]+\.\w+)[`"]?/g,
];

// ============================================
// SESSION INGESTER
// ============================================

export class SessionIngester {
  private persistence: GraphPersistence;
  private workDir: string;

  constructor(persistence?: GraphPersistence, workDir?: string) {
    this.persistence = persistence || getGraphPersistence();
    this.workDir = workDir || WORK_DIR;
  }

  /**
   * Ingest all sessions from MEMORY/WORK/ into the graph.
   */
  async ingest(): Promise<IngestionResult> {
    const startTime = Date.now();
    const result: IngestionResult = {
      source: 'sessions',
      nodesAdded: 0,
      edgesAdded: 0,
      nodesSkipped: 0,
      edgesSkipped: 0,
      errors: [],
      duration: 0,
    };

    if (!existsSync(this.workDir)) {
      result.errors.push(`Work directory not found: ${this.workDir}`);
      result.duration = Date.now() - startTime;
      return result;
    }

    const sessionDirs = readdirSync(this.workDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    const allNodes: GraphNode[] = [];
    const allEdges: GraphEdge[] = [];

    for (const dirName of sessionDirs) {
      try {
        const { nodes, edges } = this.parseSession(dirName);
        allNodes.push(...nodes);
        allEdges.push(...edges);
      } catch (err) {
        result.errors.push(`Error parsing session ${dirName}: ${err}`);
      }
    }

    // Persist nodes and edges
    const nodesAppended = this.persistence.appendNodes(allNodes);
    const edgesAppended = this.persistence.appendEdges(allEdges);

    result.nodesAdded = nodesAppended;
    result.nodesSkipped = allNodes.length - nodesAppended;
    result.edgesAdded = edgesAppended;
    result.edgesSkipped = allEdges.length - edgesAppended;
    result.duration = Date.now() - startTime;

    return result;
  }

  /**
   * Parse a single session directory into nodes and edges.
   */
  private parseSession(dirName: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const dirPath = join(this.workDir, dirName);

    // Parse directory name: YYYYMMDD-HHMMSS_slug
    const timestamp = this.parseTimestamp(dirName);
    const slug = this.parseSlug(dirName);

    // Create session node
    const sessionId = `session:${dirName}`;
    const sessionNode = createNode(
      'session',
      sessionId,
      slug || dirName,
      {
        directory: dirName,
        timestamp: timestamp || new Date().toISOString(),
      },
      ['session'],
    );

    if (timestamp) {
      sessionNode.valid_from = timestamp;
      sessionNode.created_at = timestamp;
    }

    nodes.push(sessionNode);

    // Read session files for errors and file references
    const sessionFiles = this.getSessionFiles(dirPath);
    const seenErrors = new Set<string>();
    const seenFiles = new Set<string>();

    for (const filePath of sessionFiles) {
      try {
        const content = readFileSync(filePath, 'utf-8');

        // Extract errors
        const errors = this.extractErrors(content);
        for (const errorMsg of errors) {
          const errorKey = errorMsg.slice(0, 100);
          if (seenErrors.has(errorKey)) continue;
          seenErrors.add(errorKey);

          const errorId = `error:${dirName}:${this.hashString(errorKey)}`;
          const errorNode = createNode(
            'error',
            errorId,
            errorMsg.slice(0, 120),
            { fullMessage: errorMsg, session: dirName },
            ['error'],
          );
          if (timestamp) {
            errorNode.valid_from = timestamp;
            errorNode.created_at = timestamp;
          }
          nodes.push(errorNode);

          // session -> contains -> error
          edges.push(createEdge('contains', sessionId, errorId, 1.0, { source: 'session-ingester' }));
        }

        // Extract file references
        const files = this.extractFiles(content);
        for (const file of files) {
          if (seenFiles.has(file)) continue;
          seenFiles.add(file);

          const fileId = `file:${file}`;
          const fileNode = createNode(
            'file',
            fileId,
            file,
            { path: file },
            ['file'],
          );
          if (timestamp) {
            fileNode.valid_from = timestamp;
            fileNode.created_at = timestamp;
          }
          nodes.push(fileNode);

          // session -> modifies -> file
          edges.push(createEdge('modifies', sessionId, fileId, 0.8, { source: 'session-ingester' }));
        }
      } catch {
        // Skip unreadable files
      }
    }

    return { nodes, edges };
  }

  // ============================================
  // PARSING HELPERS
  // ============================================

  /**
   * Parse ISO timestamp from directory name (YYYYMMDD-HHMMSS_...).
   */
  private parseTimestamp(dirName: string): string | null {
    const match = dirName.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
    if (!match) return null;

    const [, year, month, day, hour, min, sec] = match;
    return `${year}-${month}-${day}T${hour}:${min}:${sec}.000Z`;
  }

  /**
   * Parse slug from directory name.
   */
  private parseSlug(dirName: string): string | null {
    const match = dirName.match(/^\d{8}-\d{6}_(.+)$/);
    if (!match) return null;
    return match[1].replace(/-/g, ' ').slice(0, 80);
  }

  /**
   * Get all readable files in a session directory.
   */
  private getSessionFiles(dirPath: string): string[] {
    if (!existsSync(dirPath)) return [];

    try {
      return readdirSync(dirPath, { withFileTypes: true })
        .filter(d => d.isFile() && (d.name.endsWith('.md') || d.name.endsWith('.json') || d.name.endsWith('.txt') || d.name.endsWith('.log')))
        .map(d => join(dirPath, d.name));
    } catch {
      return [];
    }
  }

  /**
   * Extract error messages from content.
   */
  private extractErrors(content: string): string[] {
    const errors: string[] = [];

    for (const pattern of ERROR_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        const msg = match[1] || match[0];
        if (msg && msg.length > 5 && msg.length < 500) {
          errors.push(msg.trim());
        }
      }
    }

    return errors;
  }

  /**
   * Extract file path references from content.
   */
  private extractFiles(content: string): string[] {
    const files = new Set<string>();

    for (const pattern of FILE_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        const filePath = match[1];
        if (filePath && filePath.length > 3 && filePath.length < 200) {
          files.add(filePath);
        }
      }
    }

    return Array.from(files);
  }

  /**
   * Simple hash for dedup keys.
   */
  private hashString(input: string): string {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  console.log('SessionIngester');
  console.log('===============\n');

  const ingester = new SessionIngester();
  const result = await ingester.ingest();

  console.log(`Source: ${result.source}`);
  console.log(`Nodes added: ${result.nodesAdded}`);
  console.log(`Nodes skipped: ${result.nodesSkipped}`);
  console.log(`Edges added: ${result.edgesAdded}`);
  console.log(`Edges skipped: ${result.edgesSkipped}`);
  console.log(`Duration: ${result.duration}ms`);

  if (result.errors.length > 0) {
    console.log(`\nErrors (${result.errors.length}):`);
    for (const err of result.errors.slice(0, 5)) {
      console.log(`  - ${err}`);
    }
  }
}
