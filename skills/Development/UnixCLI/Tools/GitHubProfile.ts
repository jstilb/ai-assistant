#!/usr/bin/env bun
/**
 * GitHubProfile.ts
 *
 * GitHub profile management CLI for operations not covered by `gh`:
 * pinned repos, bio, topics, traffic analytics.
 *
 * Usage: kaya-cli gh profile <command> [options]
 */

import { execSync } from 'child_process';
import { parseArgs } from 'util';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { maybeEncode } from '../../../../lib/core/ToonHelper';

const HELP = `
GitHub Profile CLI - Profile management via command line

Usage:
  kaya-cli gh profile <command> [options]

Commands:
  status                         Full profile overview
  pins                           List pinned repositories
  pin <repo1> [repo2] ...        Pin up to 6 repositories
  unpin                          Clear all pinned repositories
  bio                            View current bio
  bio "new bio text"             Update bio
  topics <repo>                  View repository topics
  topics <repo> <t1> [t2] ...   Set repository topics
  analytics [repo]               Traffic analytics for a repo

Options:
  --json                         Output as JSON
  --toon                         Output as TOON (token-efficient format for arrays)
  --help, -h                     Show this help

Examples:
  kaya-cli gh profile status
  kaya-cli gh profile pins --json
  kaya-cli gh profile pin my-repo another-repo
  kaya-cli gh profile bio "Building AI systems"
  kaya-cli gh profile topics my-repo typescript ai ml
  kaya-cli gh profile analytics my-repo --json

Authentication:
  Uses gh CLI auth (gh auth login). Some operations require
  additional scopes:
    - pin/unpin: 'user' scope (gh auth refresh -s user)
    - analytics: push access to the repo
`;

// --- Helpers ---

function gh(args: string, opts?: { raw?: boolean }): string {
  try {
    const result = execSync(`gh ${args}`, {
      timeout: 30_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch (e: any) {
    const stderr = e.stderr?.toString() || '';
    if (stderr.includes('insufficient_scope') || stderr.includes('scope')) {
      throw new Error(`Insufficient scope. Try: gh auth refresh -s user,repo\n${stderr}`);
    }
    throw new Error(stderr || e.message);
  }
}

function ghGraphQL(query: string): any {
  const escaped = query.replace(/\n/g, ' ').replace(/"/g, '\\"');
  const raw = gh(`api graphql -f query="${escaped}"`);
  return JSON.parse(raw);
}

/** For mutations with variables — writes JSON to temp file to avoid shell escaping issues */
function ghGraphQLWithVars(query: string, variables: Record<string, any>): any {
  const tmpFile = join(tmpdir(), `gh-profile-${Date.now()}.json`);
  try {
    const payload = JSON.stringify({ query, variables });
    writeFileSync(tmpFile, payload);
    const raw = execSync(`gh api graphql --input "${tmpFile}"`, {
      timeout: 30_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(raw.trim());
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

/** REST calls with JSON body via temp file */
function ghRESTWithBody(method: string, path: string, body: Record<string, any>): any {
  const tmpFile = join(tmpdir(), `gh-profile-${Date.now()}.json`);
  try {
    writeFileSync(tmpFile, JSON.stringify(body));
    const raw = execSync(`gh api -X ${method} ${path} --input "${tmpFile}"`, {
      timeout: 30_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (!raw.trim()) return {};
    return JSON.parse(raw.trim());
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

function getViewer(): string {
  const raw = gh('api user --jq .login');
  return raw;
}

function output(data: any, json: boolean, formatter?: (d: any) => string): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else if (formatter) {
    console.log(formatter(data));
  } else {
    console.log(data);
  }
}

// --- Commands ---

async function cmdStatus(json: boolean): Promise<void> {
  const query = `{
    viewer {
      login
      name
      bio
      company
      location
      websiteUrl
      twitterUsername
      followers { totalCount }
      following { totalCount }
      repositories(first: 0) { totalCount }
      pinnedItems(first: 6, types: REPOSITORY) {
        nodes { ... on Repository { nameWithOwner description stargazerCount } }
      }
    }
  }`;

  const result = ghGraphQL(query);
  const v = result.data.viewer;

  output(v, json, (d) => {
    const lines = [
      `Profile: ${d.login}${d.name ? ` (${d.name})` : ''}`,
      d.bio ? `Bio: ${d.bio}` : '',
      d.company ? `Company: ${d.company}` : '',
      d.location ? `Location: ${d.location}` : '',
      d.websiteUrl ? `Website: ${d.websiteUrl}` : '',
      d.twitterUsername ? `Twitter: @${d.twitterUsername}` : '',
      `Followers: ${d.followers.totalCount} | Following: ${d.following.totalCount} | Repos: ${d.repositories.totalCount}`,
      '',
      `Pinned (${d.pinnedItems.nodes.length}):`,
      ...d.pinnedItems.nodes.map(
        (r: any) => `  - ${r.nameWithOwner} (${r.stargazerCount} stars)${r.description ? `: ${r.description}` : ''}`
      ),
    ];
    return lines.filter(Boolean).join('\n');
  });
}

async function cmdPins(json: boolean, toon: boolean): Promise<void> {
  const query = `{
    viewer {
      pinnedItems(first: 6, types: REPOSITORY) {
        nodes {
          ... on Repository {
            name
            nameWithOwner
            description
            stargazerCount
            primaryLanguage { name }
            url
          }
        }
      }
    }
  }`;

  const result = ghGraphQL(query);
  const pins = result.data.viewer.pinnedItems.nodes;

  if (toon) {
    const encoded = maybeEncode(pins as unknown[]);
    console.log(encoded.data);
    return;
  }

  output(pins, json, (d) => {
    if (!d.length) return 'No pinned repositories.';
    return d
      .map(
        (r: any, i: number) =>
          `${i + 1}. ${r.nameWithOwner}${r.primaryLanguage ? ` [${r.primaryLanguage.name}]` : ''} (${r.stargazerCount} stars)\n   ${r.description || '(no description)'}\n   ${r.url}`
      )
      .join('\n\n');
  });
}

async function cmdPin(repos: string[], json: boolean): Promise<void> {
  if (!repos.length) {
    console.error('Error: Provide 1-6 repository names to pin.');
    console.error('Usage: kaya-cli gh profile pin <repo1> [repo2] ...');
    process.exit(1);
  }
  if (repos.length > 6) {
    console.error('Error: GitHub allows a maximum of 6 pinned repositories.');
    process.exit(1);
  }

  const owner = getViewer();

  // Resolve repo node IDs
  const ids: string[] = [];
  for (const repo of repos) {
    const repoName = repo.includes('/') ? repo : `${owner}/${repo}`;
    try {
      const result = ghGraphQL(`{ repository(owner: "${repoName.split('/')[0]}", name: "${repoName.split('/')[1]}") { id } }`);
      ids.push(result.data.repository.id);
    } catch (e: any) {
      console.error(`Error: Could not find repository '${repoName}': ${e.message}`);
      process.exit(1);
    }
  }

  // Get profile showcase ID (viewer ID)
  const viewerResult = ghGraphQL(`{ viewer { id } }`);
  const viewerId = viewerResult.data.viewer.id;

  // Attempt the mutation
  try {
    const mutation = `mutation($repositoryIds: [ID!]!, $userId: ID!) {
      updateUserProfileShowcase(input: { pinnedItemIds: $repositoryIds, userId: $userId }) {
        clientMutationId
      }
    }`;

    const result = ghGraphQLWithVars(mutation, { repositoryIds: ids, userId: viewerId });

    if (result.errors) {
      throw new Error(result.errors.map((e: any) => e.message).join(', '));
    }

    output(
      { success: true, pinned: repos },
      json,
      () => `Pinned ${repos.length} repositories: ${repos.join(', ')}`
    );
  } catch (e: any) {
    // Mutation may not be available in public schema
    const fallback = {
      success: false,
      message: 'GraphQL mutation failed. This may require manual pinning.',
      resolvedIds: ids.map((id, i) => ({ repo: repos[i], nodeId: id })),
      manualUrl: `https://github.com/${owner}?tab=repositories`,
      scopeHint: 'Ensure user scope: gh auth refresh -s user',
      error: e.message,
    };

    output(fallback, json, (d) => {
      return [
        `Pin mutation failed: ${d.error}`,
        '',
        'Resolved node IDs (for manual use):',
        ...d.resolvedIds.map((r: any) => `  ${r.repo}: ${r.nodeId}`),
        '',
        `Manual pinning: ${d.manualUrl}`,
        `Add scope: ${d.scopeHint}`,
      ].join('\n');
    });
    process.exit(1);
  }
}

async function cmdUnpin(json: boolean): Promise<void> {
  const viewerResult = ghGraphQL(`{ viewer { id } }`);
  const viewerId = viewerResult.data.viewer.id;

  try {
    const mutation = `mutation($userId: ID!) {
      updateUserProfileShowcase(input: { pinnedItemIds: [], userId: $userId }) {
        clientMutationId
      }
    }`;

    const result = ghGraphQLWithVars(mutation, { userId: viewerId });

    if (result.errors) {
      throw new Error(result.errors.map((e: any) => e.message).join(', '));
    }

    output({ success: true }, json, () => 'All pinned repositories cleared.');
  } catch (e: any) {
    const fallback = {
      success: false,
      message: 'Unpin mutation failed.',
      manualUrl: 'https://github.com/settings/profile',
      error: e.message,
    };
    output(fallback, json, (d) => `Unpin failed: ${d.error}\nManual: ${d.manualUrl}`);
    process.exit(1);
  }
}

async function cmdBio(newBio: string | undefined, json: boolean): Promise<void> {
  if (newBio === undefined) {
    // GET bio
    const result = ghGraphQL(`{ viewer { bio } }`);
    output(result.data.viewer, json, (d) => d.bio || '(no bio set)');
  } else {
    // SET bio via REST
    const result = ghRESTWithBody('PATCH', '/user', { bio: newBio });
    output(
      { success: true, bio: result.bio },
      json,
      (d) => `Bio updated: ${d.bio}`
    );
  }
}

async function cmdTopics(repo: string, newTopics: string[] | undefined, json: boolean): Promise<void> {
  const owner = getViewer();
  const repoName = repo.includes('/') ? repo : `${owner}/${repo}`;
  const [o, r] = repoName.split('/');

  if (!newTopics || newTopics.length === 0) {
    // GET topics
    const raw = gh(`api /repos/${o}/${r}/topics`);
    const result = JSON.parse(raw);
    output(result, json, (d) => {
      if (!d.names?.length) return `${repoName}: no topics set`;
      return `${repoName} topics:\n${d.names.map((t: string) => `  - ${t}`).join('\n')}`;
    });
  } else {
    // SET topics
    const result = ghRESTWithBody('PUT', `/repos/${o}/${r}/topics`, { names: newTopics });
    output(
      { success: true, repo: repoName, topics: result.names },
      json,
      (d) => `Topics set for ${d.repo}: ${d.topics.join(', ')}`
    );
  }
}

async function cmdAnalytics(repo: string | undefined, json: boolean, toon: boolean): Promise<void> {
  const owner = getViewer();

  if (!repo) {
    // Show top repos by stars for overview
    const query = `{
      viewer {
        repositories(first: 10, orderBy: {field: STARGAZERS, direction: DESC}, ownerAffiliations: OWNER) {
          nodes { name stargazerCount forkCount }
        }
      }
    }`;
    const result = ghGraphQL(query);
    const repos = result.data.viewer.repositories.nodes;

    if (toon) {
      const encoded = maybeEncode(repos as unknown[]);
      console.log(encoded.data);
      return;
    }

    output(repos, json, (d) => {
      return [
        'Top repositories by stars:',
        ...d.map((r: any) => `  ${r.name}: ${r.stargazerCount} stars, ${r.forkCount} forks`),
        '',
        'For detailed traffic: kaya-cli gh profile analytics <repo>',
      ].join('\n');
    });
    return;
  }

  const repoName = repo.includes('/') ? repo : `${owner}/${repo}`;
  const [o, r] = repoName.split('/');

  // Fetch traffic data in parallel-ish (sequential for simplicity, gh handles auth)
  let views: any, clones: any, referrers: any, paths: any;
  try {
    views = JSON.parse(gh(`api /repos/${o}/${r}/traffic/views`));
    clones = JSON.parse(gh(`api /repos/${o}/${r}/traffic/clones`));
    referrers = JSON.parse(gh(`api /repos/${o}/${r}/traffic/popular/referrers`));
    paths = JSON.parse(gh(`api /repos/${o}/${r}/traffic/popular/paths`));
  } catch (e: any) {
    if (e.message.includes('Must have push access')) {
      console.error(`Error: Traffic analytics require push access to ${repoName}`);
      process.exit(1);
    }
    throw e;
  }

  const analytics = {
    repo: repoName,
    views: { total: views.count, unique: views.uniques, daily: views.views },
    clones: { total: clones.count, unique: clones.uniques, daily: clones.clones },
    referrers,
    popularPaths: paths,
  };

  output(analytics, json, (d) => {
    const lines = [
      `Analytics for ${d.repo} (last 14 days):`,
      '',
      `Views: ${d.views.total} total, ${d.views.unique} unique`,
      `Clones: ${d.clones.total} total, ${d.clones.unique} unique`,
    ];

    if (d.referrers?.length) {
      lines.push('', 'Top Referrers:');
      d.referrers.slice(0, 5).forEach((r: any) => {
        lines.push(`  ${r.referrer}: ${r.count} (${r.uniques} unique)`);
      });
    }

    if (d.popularPaths?.length) {
      lines.push('', 'Popular Paths:');
      d.popularPaths.slice(0, 5).forEach((p: any) => {
        lines.push(`  ${p.path}: ${p.count} (${p.uniques} unique)`);
      });
    }

    return lines.join('\n');
  });
}

// --- Main ---

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      json: { type: 'boolean', default: false },
      toon: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    process.exit(0);
  }

  const jsonOutput = values.json ?? false;
  const toonOutput = values.toon ?? false;
  const [command, ...args] = positionals;

  try {
    switch (command) {
      case 'status':
        await cmdStatus(jsonOutput);
        break;

      case 'pins':
        await cmdPins(jsonOutput, toonOutput);
        break;

      case 'pin':
        await cmdPin(args, jsonOutput);
        break;

      case 'unpin':
        await cmdUnpin(jsonOutput);
        break;

      case 'bio':
        await cmdBio(args[0], jsonOutput);
        break;

      case 'topics':
        if (!args[0]) {
          console.error('Error: Provide a repository name.');
          console.error('Usage: kaya-cli gh profile topics <repo> [topic1 topic2 ...]');
          process.exit(1);
        }
        await cmdTopics(args[0], args.slice(1).length ? args.slice(1) : undefined, jsonOutput);
        break;

      case 'analytics':
        await cmdAnalytics(args[0], jsonOutput, toonOutput);
        break;

      default:
        console.error(`Error: Unknown command '${command}'`);
        console.error('Run: kaya-cli gh profile --help');
        process.exit(1);
    }
  } catch (e: any) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

main();
