#!/usr/bin/env bun
/**
 * GitIngester - Parse git log into graph nodes
 *
 * Runs git log to extract recent commits, creates commit nodes
 * and file nodes, links them with modifies edges, and
 * correlates sessions to commits by timestamp.
 *
 * @module Graph/GitIngester
 * @version 1.0.0
 */

import { join } from 'path';
import { homedir } from 'os';
import type { GraphNode, GraphEdge, IngestionResult } from '../types';
import { createNode, createEdge } from '../types';
import { GraphPersistence, getGraphPersistence } from '../GraphPersistence';

// ============================================
// CONSTANTS
// ============================================

const KAYA_HOME = join(homedir(), '.claude');

// ============================================
// GIT COMMIT INFO
// ============================================

interface GitCommitInfo {
  hash: string;
  short: string;
  subject: string;
  author: string;
  date: string;
}

// ============================================
// GIT INGESTER
// ============================================

export class GitIngester {
  private persistence: GraphPersistence;
  private repoDir: string;

  constructor(persistence?: GraphPersistence, repoDir?: string) {
    this.persistence = persistence || getGraphPersistence();
    this.repoDir = repoDir || KAYA_HOME;
  }

  /**
   * Ingest recent git commits into the graph.
   * @param limit Number of recent commits to ingest (default: 100)
   */
  async ingest(limit: number = 100): Promise<IngestionResult> {
    const startTime = Date.now();
    const result: IngestionResult = {
      source: 'git',
      nodesAdded: 0,
      edgesAdded: 0,
      nodesSkipped: 0,
      edgesSkipped: 0,
      errors: [],
      duration: 0,
    };

    try {
      // Get recent commits
      const commits = await this.getRecentCommits(limit);

      if (commits.length === 0) {
        result.errors.push('No commits found');
        result.duration = Date.now() - startTime;
        return result;
      }

      const allNodes: GraphNode[] = [];
      const allEdges: GraphEdge[] = [];
      const seenFiles = new Set<string>();

      for (const commit of commits) {
        // Create commit node
        const commitId = `commit:${commit.short}`;
        const commitNode = createNode(
          'commit',
          commitId,
          commit.subject,
          {
            hash: commit.hash,
            shortHash: commit.short,
            author: commit.author,
            date: commit.date,
          },
          this.extractTags(commit.subject),
        );
        commitNode.valid_from = commit.date;
        commitNode.created_at = commit.date;

        allNodes.push(commitNode);

        // Get changed files for this commit
        try {
          const changedFiles = await this.getChangedFiles(commit.hash);

          for (const filePath of changedFiles) {
            const fileId = `file:${filePath}`;

            // Create file node (if not already seen in this batch)
            if (!seenFiles.has(filePath)) {
              seenFiles.add(filePath);
              const fileNode = createNode(
                'file',
                fileId,
                filePath,
                { path: filePath },
                ['file'],
              );
              fileNode.valid_from = commit.date;
              fileNode.created_at = commit.date;
              allNodes.push(fileNode);
            }

            // commit -> modifies -> file
            allEdges.push(createEdge(
              'modifies',
              commitId,
              fileId,
              1.0,
              { source: 'git-ingester', commitHash: commit.short },
            ));

            // Detect skill changes
            if (filePath.startsWith('skills/') && (filePath.endsWith('.ts') || filePath.endsWith('.md'))) {
              const skillChangeId = `skill_change:${commit.short}:${filePath}`;
              const skillNode = createNode(
                'skill_change',
                skillChangeId,
                `${filePath} changed in ${commit.short}`,
                {
                  file: filePath,
                  commitHash: commit.short,
                  commitSubject: commit.subject,
                },
                ['skill_change'],
              );
              skillNode.valid_from = commit.date;
              skillNode.created_at = commit.date;
              allNodes.push(skillNode);

              // commit -> contains -> skill_change
              allEdges.push(createEdge(
                'contains',
                commitId,
                skillChangeId,
                1.0,
                { source: 'git-ingester' },
              ));
            }
          }
        } catch (err) {
          result.errors.push(`Error getting files for ${commit.short}: ${err}`);
        }
      }

      // Persist
      const nodesAppended = this.persistence.appendNodes(allNodes);
      const edgesAppended = this.persistence.appendEdges(allEdges);

      result.nodesAdded = nodesAppended;
      result.nodesSkipped = allNodes.length - nodesAppended;
      result.edgesAdded = edgesAppended;
      result.edgesSkipped = allEdges.length - edgesAppended;

    } catch (err) {
      result.errors.push(`Git ingestion failed: ${err}`);
    }

    result.duration = Date.now() - startTime;
    return result;
  }

  // ============================================
  // GIT OPERATIONS
  // ============================================

  /**
   * Get recent commits from git log.
   */
  private async getRecentCommits(limit: number): Promise<GitCommitInfo[]> {
    const proc = Bun.spawnSync([
      'git', 'log',
      `--format={"hash":"%H","short":"%h","subject":"%s","author":"%an","date":"%aI"}`,
      `-${limit}`,
    ], {
      cwd: this.repoDir,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    if (proc.exitCode !== 0) {
      throw new Error(`git log failed: ${proc.stderr.toString()}`);
    }

    const output = proc.stdout.toString().trim();
    if (!output) return [];

    const commits: GitCommitInfo[] = [];
    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      try {
        // Escape any unescaped quotes in the subject line
        const sanitized = line.replace(/"subject":"(.*?)","/g, (match, subject) => {
          const escaped = subject.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          return `"subject":"${escaped}","`;
        });
        commits.push(JSON.parse(sanitized));
      } catch {
        // Try a simpler parse approach for problematic lines
        try {
          const hashMatch = line.match(/"hash":"([^"]+)"/);
          const shortMatch = line.match(/"short":"([^"]+)"/);
          const authorMatch = line.match(/"author":"([^"]+)"/);
          const dateMatch = line.match(/"date":"([^"]+)"/);
          const subjectMatch = line.match(/"subject":"(.+?)","author"/);

          if (hashMatch && shortMatch) {
            commits.push({
              hash: hashMatch[1],
              short: shortMatch[1],
              subject: subjectMatch?.[1] || 'unknown',
              author: authorMatch?.[1] || 'unknown',
              date: dateMatch?.[1] || new Date().toISOString(),
            });
          }
        } catch {
          // Skip completely unparseable lines
        }
      }
    }

    return commits;
  }

  /**
   * Get changed files for a specific commit.
   */
  private async getChangedFiles(hash: string): Promise<string[]> {
    const proc = Bun.spawnSync([
      'git', 'diff-tree', '--no-commit-id', '-r', '--name-only', hash,
    ], {
      cwd: this.repoDir,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    if (proc.exitCode !== 0) {
      return [];
    }

    const output = proc.stdout.toString().trim();
    if (!output) return [];

    return output.split('\n').filter(f => f.trim().length > 0);
  }

  /**
   * Extract tags from commit subject line.
   */
  private extractTags(subject: string): string[] {
    const tags: string[] = ['commit'];

    // Conventional commit prefixes
    const prefixMatch = subject.match(/^(feat|fix|docs|style|refactor|test|chore|perf|ci|build|revert)(?:\(.+?\))?:/i);
    if (prefixMatch) {
      tags.push(prefixMatch[1].toLowerCase());
    }

    // Scope extraction
    const scopeMatch = subject.match(/^(?:feat|fix|docs|style|refactor|test|chore|perf|ci|build|revert)\((.+?)\):/i);
    if (scopeMatch) {
      tags.push(`scope:${scopeMatch[1]}`);
    }

    return tags;
  }
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  console.log('GitIngester');
  console.log('===========\n');

  const args = process.argv.slice(2);
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 100;

  const ingester = new GitIngester();
  const result = await ingester.ingest(limit);

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
