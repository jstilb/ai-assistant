# Supabase Workflow

Supabase operations via official `supabase` CLI.

## Prerequisites

- Supabase CLI installed
- Supabase account

## Installation

```bash
# Install via Homebrew
brew install supabase/tap/supabase

# Or via install script (--all flag)
bash ~/.claude/tools/UnixCLI/install-cli-tools.sh --all
```

## Authentication

```bash
# Login (opens browser)
supabase login

# Check status
supabase projects list
```

## Quick Start

```bash
# List projects
kaya-cli supabase projects list

# Start local development
kaya-cli supabase start

# Generate types
kaya-cli supabase gen types typescript
```

## Commands

All `supabase` commands are passed through. Common ones:

| Command | Description |
|---------|-------------|
| `projects list` | List projects |
| `start` | Start local Supabase |
| `stop` | Stop local Supabase |
| `db diff` | Show database changes |
| `db push` | Push migrations |
| `gen types` | Generate TypeScript types |
| `functions serve` | Serve Edge Functions locally |
| `functions deploy` | Deploy Edge Functions |
| `secrets list` | List project secrets |

## Common Operations

### Projects

```bash
# List projects
kaya-cli supabase projects list

# Link to existing project
kaya-cli supabase link --project-ref your-project-ref
```

### Local Development

```bash
# Start local Supabase stack
kaya-cli supabase start

# Stop
kaya-cli supabase stop

# Status
kaya-cli supabase status
```

### Database

```bash
# Create migration
kaya-cli supabase migration new add_users_table

# Run migrations
kaya-cli supabase db push

# Show diff
kaya-cli supabase db diff

# Reset (destructive!)
kaya-cli supabase db reset
```

### Edge Functions

```bash
# Create function
kaya-cli supabase functions new my-function

# Serve locally
kaya-cli supabase functions serve

# Deploy
kaya-cli supabase functions deploy my-function
```

### Type Generation

```bash
# Generate TypeScript types from database
kaya-cli supabase gen types typescript --local > types/supabase.ts

# From remote
kaya-cli supabase gen types typescript --project-id your-project-id
```

## Integration Examples

### CI/CD

```bash
#!/bin/bash
# deploy.sh

# Run migrations
kaya-cli supabase db push

# Deploy functions
kaya-cli supabase functions deploy --all

echo "Deployed successfully"
```

### Type Safety

```bash
# Generate and use types
kaya-cli supabase gen types typescript --local > src/types/database.ts
```

## Documentation

- Supabase CLI: https://supabase.com/docs/reference/cli
- Supabase: https://supabase.com/docs
