// Configuration for bug bounty tracker

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Resolve paths relative to the BugBountyTool directory
const TOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CONFIG = {
  // GitHub repository
  repo: {
    owner: 'arkadiyt',
    name: 'bounty-targets-data',
  },

  // Data file paths in the repository
  files: {
    domains_txt: 'domains.txt',
    hackerone: 'data/hackerone_data.json',
    bugcrowd: 'data/bugcrowd_data.json',
    intigriti: 'data/intigriti_data.json',
    yeswehack: 'data/yeswehack_data.json',
  },

  // Local paths (resolved relative to BugBountyTool directory)
  paths: {
    root: TOOL_DIR,
    state: resolve(TOOL_DIR, 'state.json'),
    cache: resolve(TOOL_DIR, 'cache'),
    logs: resolve(TOOL_DIR, 'logs'),
  },

  // GitHub API
  api: {
    base: 'https://api.github.com',
    raw_base: 'https://raw.githubusercontent.com',
  },

  // Cache settings
  cache: {
    max_age_days: 30,
    metadata_file: 'programs_metadata.json',
    recent_changes_file: 'recent_changes.json',
  },
} as const;
