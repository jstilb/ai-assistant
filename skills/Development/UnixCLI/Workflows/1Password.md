# 1Password Workflow

Secret management via `op` CLI (official 1Password CLI).

## Prerequisites

- 1Password account
- 1Password CLI installed

## Installation

```bash
# Install via Homebrew
brew install --cask 1password-cli

# Or via install script
bash ~/.claude/tools/UnixCLI/install-cli-tools.sh
```

## Authentication

```bash
# Sign in (first time - opens browser if 1Password app is installed)
op signin

# Sign in to specific account
op signin --account my.1password.com

# Check status
op account get
```

## Quick Start

```bash
# List items
kaya-cli op item list

# Get a secret
kaya-cli op read "op://Vault/Item/field"

# List vaults
kaya-cli op vault list
```

## Commands

All `op` commands are passed through. Common ones:

| Command | Description |
|---------|-------------|
| `item list` | List items |
| `item get` | Get item details |
| `item create` | Create new item |
| `read` | Read a secret value |
| `vault list` | List vaults |
| `document get` | Get a document |
| `inject` | Inject secrets into files |

## Secret Reading

### Read Single Value

```bash
# Using op:// reference
kaya-cli op read "op://Personal/API Key/credential"

# Using item and field
kaya-cli op item get "API Key" --fields credential

# With vault
kaya-cli op read "op://Work/Database/password"
```

### List Items

```bash
# All items
kaya-cli op item list

# In specific vault
kaya-cli op item list --vault Personal

# Filter by category
kaya-cli op item list --categories Login

# JSON output
kaya-cli op item list --format json
```

### Get Full Item

```bash
# Full item details
kaya-cli op item get "GitHub Token"

# Specific fields
kaya-cli op item get "AWS" --fields "Access Key ID,Secret Access Key"

# As JSON
kaya-cli op item get "AWS" --format json
```

## Secret Injection

### Environment Variables

```bash
# Run command with secrets
kaya-cli op run --env-file=.env.1password -- ./my-script.sh

# Inject into current shell
eval $(kaya-cli op signin --account my.1password.com)
export API_KEY=$(kaya-cli op read "op://Dev/API Key/credential")
```

### Config Files

```bash
# Template file (config.template.json):
# {
#   "api_key": "op://Dev/API Key/credential",
#   "db_password": "op://Dev/Database/password"
# }

# Inject secrets
kaya-cli op inject -i config.template.json -o config.json
```

## Integration Examples

### Script with Secrets

```bash
#!/bin/bash
# deploy.sh

# Get secrets
DB_PASSWORD=$(kaya-cli op read "op://Production/Database/password")
API_KEY=$(kaya-cli op read "op://Production/API/key")

# Use in deployment
export DATABASE_URL="postgres://user:${DB_PASSWORD}@host/db"
export API_KEY="$API_KEY"

./deploy
```

### Docker with Secrets

```bash
# Pass secrets to container
docker run \
    -e API_KEY=$(kaya-cli op read "op://Dev/API/key") \
    -e DB_PASS=$(kaya-cli op read "op://Dev/DB/password") \
    myapp
```

### CI/CD Integration

```bash
# In GitHub Actions (using 1Password Connect)
# secrets.yaml
API_KEY: op://Production/API Key/credential
DB_PASSWORD: op://Production/Database/password

# inject.sh
kaya-cli op inject -i secrets.yaml | export
```

### Backup Script

```bash
#!/bin/bash
# backup.sh - with encrypted credentials

BACKUP_KEY=$(kaya-cli op read "op://Backups/Encryption Key/key")
S3_SECRET=$(kaya-cli op read "op://AWS/S3/secret_key")

# Encrypt and upload
tar czf - ./data | \
    gpg --symmetric --passphrase "$BACKUP_KEY" | \
    aws s3 cp - s3://backups/data.tar.gz.gpg
```

## Kaya Integration

### Use in kaya-cli tools

```bash
# Store Asana token in 1Password
# Then read it when needed
export ASANA_ACCESS_TOKEN=$(kaya-cli op read "op://Dev/Asana/token")
kaya-cli tasks
```

### Secrets Bridge

```bash
#!/bin/bash
# sync-secrets.sh
# Sync 1Password secrets to secrets.json for Kaya tools

kaya-cli op item get "Kaya Secrets" --format json | jq '{
  ELEVENLABS_API_KEY: .fields[] | select(.label == "elevenlabs") | .value,
  ASANA_ACCESS_TOKEN: .fields[] | select(.label == "asana") | .value
}' > ~/.claude/secrets.json
```

## Error Handling

```bash
# Check if signed in
if ! kaya-cli op account get &> /dev/null; then
    echo "Not signed in. Run: op signin"
    exit 1
fi

# Check if item exists
if ! kaya-cli op item get "My Item" &> /dev/null; then
    echo "Item not found"
    exit 1
fi
```

## Security Best Practices

1. **Never echo secrets** - Don't log or print secret values
2. **Use op:// references** - Let 1Password resolve at runtime
3. **Short sessions** - Sign out when done: `op signout`
4. **Biometrics** - Enable Touch ID for `op` commands
5. **Audit logs** - 1Password logs all access

## CLI vs MCP

| Use CLI When | Use MCP When |
|--------------|--------------|
| Script secrets | Interactive browsing |
| CI/CD pipelines | Complex item creation |
| Automation | Team management |
| Quick lookups | Bulk operations |

## Documentation

- 1Password CLI: https://developer.1password.com/docs/cli/
- Secret References: https://developer.1password.com/docs/cli/secret-references/
