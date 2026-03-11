# Stripe Workflow

Stripe operations via official `stripe` CLI.

## Prerequisites

- Stripe CLI installed
- Stripe account

## Installation

```bash
# Install via Homebrew
brew install stripe/stripe-cli/stripe

# Or via install script (--all flag)
bash ~/.claude/tools/UnixCLI/install-cli-tools.sh --all
```

## Authentication

```bash
# Login (opens browser)
stripe login

# Check status
stripe status
```

## Quick Start

```bash
# List recent events
kaya-cli stripe events list --limit 5

# Get customer
kaya-cli stripe customers retrieve cus_xxx

# Listen for webhooks
kaya-cli stripe listen --forward-to localhost:3000/webhook
```

## Commands

All `stripe` commands are passed through. Common ones:

| Command | Description |
|---------|-------------|
| `events list` | List events |
| `customers list` | List customers |
| `customers retrieve` | Get customer details |
| `charges list` | List charges |
| `subscriptions list` | List subscriptions |
| `listen` | Listen for webhooks |
| `trigger` | Trigger test events |

## Common Operations

### Events

```bash
# Recent events
kaya-cli stripe events list --limit 10

# Filter by type
kaya-cli stripe events list --type payment_intent.succeeded

# Resend event
kaya-cli stripe events resend evt_xxx
```

### Customers

```bash
# List customers
kaya-cli stripe customers list --limit 5

# Get customer
kaya-cli stripe customers retrieve cus_xxx

# Create customer
kaya-cli stripe customers create --email user@example.com
```

### Webhooks

```bash
# Local webhook testing
kaya-cli stripe listen --forward-to localhost:3000/webhook

# With specific events
kaya-cli stripe listen \
    --events payment_intent.succeeded,checkout.session.completed \
    --forward-to localhost:3000/webhook

# Print events only
kaya-cli stripe listen --print-json
```

### Testing

```bash
# Trigger test payment
kaya-cli stripe trigger payment_intent.succeeded

# Trigger checkout
kaya-cli stripe trigger checkout.session.completed

# Create test customer
kaya-cli stripe customers create --email test@example.com
```

## Integration Examples

### Webhook Handler

```bash
#!/bin/bash
# Start webhook forwarding
kaya-cli stripe listen --forward-to localhost:3000/webhook &
STRIPE_PID=$!

# Run your server
npm run dev

# Cleanup
kill $STRIPE_PID
```

### Event Monitoring

```bash
#!/bin/bash
# Monitor for failed payments
kaya-cli stripe listen --print-json | \
    jq -r 'select(.type == "payment_intent.payment_failed") | .data.object.id'
```

## Documentation

- Stripe CLI: https://stripe.com/docs/stripe-cli
- Stripe API: https://stripe.com/docs/api
