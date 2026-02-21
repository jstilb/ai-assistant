# Firebase Workflow

Firebase operations via official `firebase` CLI.

## Prerequisites

- Firebase CLI installed (Node.js required)
- Firebase/Google account

## Installation

```bash
# Install via npm
npm install -g firebase-tools

# Or via install script (--all flag)
bash ~/.claude/tools/UnixCLI/install-cli-tools.sh --all
```

## Authentication

```bash
# Login (opens browser)
firebase login

# Check projects
firebase projects:list
```

## Quick Start

```bash
# List projects
kaya-cli firebase projects:list

# Initialize project
kaya-cli firebase init

# Deploy
kaya-cli firebase deploy
```

## Commands

All `firebase` commands are passed through. Common ones:

| Command | Description |
|---------|-------------|
| `projects:list` | List projects |
| `init` | Initialize Firebase in project |
| `deploy` | Deploy to Firebase |
| `serve` | Start local emulator |
| `hosting:channel:deploy` | Preview deployment |
| `functions:log` | View function logs |
| `emulators:start` | Start all emulators |

## Common Operations

### Projects

```bash
# List projects
kaya-cli firebase projects:list

# Use specific project
kaya-cli firebase use my-project

# Add Firebase to existing GCP project
kaya-cli firebase projects:addfirebase my-gcp-project
```

### Hosting

```bash
# Deploy hosting only
kaya-cli firebase deploy --only hosting

# Preview deployment
kaya-cli firebase hosting:channel:deploy preview

# Serve locally
kaya-cli firebase serve --only hosting
```

### Functions

```bash
# Deploy functions
kaya-cli firebase deploy --only functions

# Deploy specific function
kaya-cli firebase deploy --only functions:myFunction

# View logs
kaya-cli firebase functions:log

# Delete function
kaya-cli firebase functions:delete myFunction
```

### Emulators

```bash
# Start all emulators
kaya-cli firebase emulators:start

# Specific emulators
kaya-cli firebase emulators:start --only functions,firestore

# Export data
kaya-cli firebase emulators:export ./emulator-data
```

### Firestore

```bash
# Export data
kaya-cli firebase firestore:delete --all-collections

# Import/Export (via gcloud)
gcloud firestore export gs://my-bucket/backup
```

## Integration Examples

### CI/CD Deployment

```bash
#!/bin/bash
# deploy.sh

# Deploy hosting and functions
kaya-cli firebase deploy --only hosting,functions

# Create preview URL
kaya-cli firebase hosting:channel:deploy pr-$PR_NUMBER
```

### Local Development

```bash
#!/bin/bash
# Start emulators for local dev
kaya-cli firebase emulators:start --import=./emulator-data --export-on-exit
```

## Documentation

- Firebase CLI: https://firebase.google.com/docs/cli
- Firebase: https://firebase.google.com/docs
