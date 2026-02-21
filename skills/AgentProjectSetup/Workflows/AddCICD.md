# AddCICD Workflow

**Add CI/CD pipeline with quality gates for AI agent projects.**

---

## Voice Notification

```bash
curl -s -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the AddCICD workflow from the AgentProjectSetup skill"}' \
  > /dev/null 2>&1 &
```

---

## Prerequisites

Confirm with user:

1. **Project path** - Location of existing agent project
2. **Deployment targets**:
   - Staging environment (default: yes)
   - Production environment (default: yes)
3. **Deployment method**:
   - Container-based (Docker) - default
   - Serverless (AWS Lambda, Cloud Run)
   - Platform (Railway, Render, Fly.io)
4. **Quality gates**:
   - Tests required (default: yes)
   - LLM evaluations (default: on main only)
   - Code review required (default: yes)

---

## Step 1: Create GitHub Actions Directory

```bash
mkdir -p .github/workflows
```

---

## Step 2: Create CI Workflow

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

env:
  PYTHON_VERSION: '3.11'

jobs:
  # ==========================================
  # QUALITY GATES
  # ==========================================

  lint:
    name: Lint & Format
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: ${{ env.PYTHON_VERSION }}
          cache: 'pip'

      - name: Install dependencies
        run: pip install ruff mypy

      - name: Run Ruff linter
        run: ruff check src tests

      - name: Run Ruff formatter
        run: ruff format --check src tests

  typecheck:
    name: Type Check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: ${{ env.PYTHON_VERSION }}
          cache: 'pip'

      - name: Install dependencies
        run: pip install -e ".[dev]"

      - name: Run MyPy
        run: mypy src --ignore-missing-imports

  # ==========================================
  # TESTING
  # ==========================================

  unit-tests:
    name: Unit Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: ${{ env.PYTHON_VERSION }}
          cache: 'pip'

      - name: Install dependencies
        run: pip install -e ".[dev]"

      - name: Run unit tests
        run: pytest tests/unit -v --tb=short --cov=src --cov-report=xml

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          file: ./coverage.xml
          fail_ci_if_error: false

  integration-tests:
    name: Integration Tests
    runs-on: ubuntu-latest
    needs: [lint, typecheck, unit-tests]
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: ${{ env.PYTHON_VERSION }}
          cache: 'pip'

      - name: Install dependencies
        run: pip install -e ".[dev]"

      - name: Run integration tests
        run: pytest tests/integration -v --tb=short
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          ENVIRONMENT: test

  # ==========================================
  # LLM EVALUATIONS (Main branch only)
  # ==========================================

  llm-evals:
    name: LLM Evaluations
    runs-on: ubuntu-latest
    needs: [integration-tests]
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: ${{ env.PYTHON_VERSION }}
          cache: 'pip'

      - name: Install dependencies
        run: pip install -e ".[dev]"

      - name: Run LLM evaluations
        run: pytest tests/evals -v -m evals --tb=short
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          LANGCHAIN_API_KEY: ${{ secrets.LANGCHAIN_API_KEY }}
          LANGCHAIN_TRACING_V2: true

      - name: Check evaluation thresholds
        run: |
          echo "Checking evaluation results..."
          # Add threshold checking logic here
        continue-on-error: true

  # ==========================================
  # BUILD
  # ==========================================

  build:
    name: Build Docker Image
    runs-on: ubuntu-latest
    needs: [integration-tests]
    if: github.event_name == 'push'
    outputs:
      image_tag: ${{ steps.meta.outputs.tags }}

    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Docker meta
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=sha,prefix=
            type=ref,event=branch
            type=semver,pattern={{version}}

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          file: docker/Dockerfile
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

---

## Step 3: Create Staging Deployment Workflow

Create `.github/workflows/deploy-staging.yml`:

```yaml
name: Deploy to Staging

on:
  push:
    branches: [main]
  workflow_dispatch:

env:
  ENVIRONMENT: staging

jobs:
  deploy:
    name: Deploy to Staging
    runs-on: ubuntu-latest
    environment: staging

    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          file: docker/Dockerfile
          push: true
          tags: ghcr.io/${{ github.repository }}:staging
          build-args: |
            ENVIRONMENT=staging

      # Option 1: Deploy to Railway
      - name: Deploy to Railway
        if: ${{ vars.DEPLOY_TARGET == 'railway' }}
        run: |
          curl -X POST "${{ secrets.RAILWAY_WEBHOOK_URL }}" \
            -H "Content-Type: application/json" \
            -d '{"ref": "${{ github.sha }}"}'

      # Option 2: Deploy to Cloud Run
      - name: Deploy to Cloud Run
        if: ${{ vars.DEPLOY_TARGET == 'cloudrun' }}
        uses: google-github-actions/deploy-cloudrun@v2
        with:
          service: agent-staging
          image: ghcr.io/${{ github.repository }}:staging
          region: us-central1

      # Option 3: Deploy to custom infrastructure
      - name: Deploy to Custom Infrastructure
        if: ${{ vars.DEPLOY_TARGET == 'custom' }}
        run: |
          # SSH and deploy
          echo "Deploying to staging..."
          # Add your deployment commands

      - name: Verify deployment
        run: |
          echo "Waiting for deployment to stabilize..."
          sleep 30
          # Add health check
          # curl -f ${{ vars.STAGING_URL }}/health || exit 1

      - name: Notify on success
        if: success()
        run: |
          echo "✅ Staging deployment successful"
          # Add Slack/Discord notification

      - name: Notify on failure
        if: failure()
        run: |
          echo "❌ Staging deployment failed"
          # Add alert notification
```

---

## Step 4: Create Production Deployment Workflow

Create `.github/workflows/deploy-production.yml`:

```yaml
name: Deploy to Production

on:
  release:
    types: [published]
  workflow_dispatch:
    inputs:
      version:
        description: 'Version to deploy (e.g., v1.0.0)'
        required: true

env:
  ENVIRONMENT: production

jobs:
  # ==========================================
  # PRE-DEPLOYMENT CHECKS
  # ==========================================

  pre-deploy-checks:
    name: Pre-Deployment Checks
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Verify tests passed
        run: |
          # Check that CI passed for this commit
          gh run list --commit ${{ github.sha }} --status success --limit 1 | grep -q "CI" || exit 1
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Verify staging deployment
        run: |
          echo "Verifying staging is healthy..."
          # curl -f ${{ vars.STAGING_URL }}/health || exit 1

      - name: Check LLM eval scores
        run: |
          echo "Checking evaluation scores from LangSmith..."
          # Add logic to verify eval scores meet threshold

  # ==========================================
  # DEPLOYMENT
  # ==========================================

  deploy:
    name: Deploy to Production
    runs-on: ubuntu-latest
    needs: [pre-deploy-checks]
    environment: production

    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Get version
        id: version
        run: |
          if [ "${{ github.event_name }}" == "release" ]; then
            echo "version=${{ github.event.release.tag_name }}" >> $GITHUB_OUTPUT
          else
            echo "version=${{ github.event.inputs.version }}" >> $GITHUB_OUTPUT
          fi

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          file: docker/Dockerfile
          push: true
          tags: |
            ghcr.io/${{ github.repository }}:production
            ghcr.io/${{ github.repository }}:${{ steps.version.outputs.version }}
          build-args: |
            ENVIRONMENT=production

      - name: Deploy to Production
        run: |
          echo "Deploying version ${{ steps.version.outputs.version }} to production..."
          # Add your production deployment commands

      - name: Verify deployment
        run: |
          echo "Waiting for deployment to stabilize..."
          sleep 60
          # curl -f ${{ vars.PRODUCTION_URL }}/health || exit 1

      - name: Create deployment record
        run: |
          echo "Recording deployment..."
          # Log to deployment tracking system

  # ==========================================
  # POST-DEPLOYMENT
  # ==========================================

  post-deploy:
    name: Post-Deployment Verification
    runs-on: ubuntu-latest
    needs: [deploy]

    steps:
      - uses: actions/checkout@v4

      - name: Run smoke tests
        run: |
          echo "Running production smoke tests..."
          # Add smoke test commands

      - name: Verify metrics
        run: |
          echo "Checking production metrics..."
          # Verify no error spike after deployment

      - name: Notify team
        if: always()
        run: |
          if [ "${{ job.status }}" == "success" ]; then
            echo "✅ Production deployment successful"
          else
            echo "⚠️ Post-deployment checks failed"
          fi
          # Add notification to team channel
```

---

## Step 5: Create Branch Protection Rules

Create `.github/branch-protection.md` (documentation):

```markdown
# Branch Protection Configuration

## Main Branch Protection

Go to: Settings → Branches → Add rule

### Rule settings for `main`:

- [x] Require a pull request before merging
  - [x] Require approvals: 1
  - [x] Dismiss stale pull request approvals when new commits are pushed
  - [x] Require review from Code Owners

- [x] Require status checks to pass before merging
  - [x] Require branches to be up to date before merging
  - Required checks:
    - `lint`
    - `typecheck`
    - `unit-tests`
    - `integration-tests`

- [x] Require conversation resolution before merging

- [x] Do not allow bypassing the above settings

## Develop Branch Protection

### Rule settings for `develop`:

- [x] Require status checks to pass
  - Required checks:
    - `lint`
    - `typecheck`
    - `unit-tests`
```

---

## Step 6: Create CODEOWNERS

Create `.github/CODEOWNERS`:

```
# Default owners for everything
* @your-username

# Agent logic requires senior review
/src/agent/ @your-username @senior-engineer

# Security-sensitive files
/src/security/ @your-username @security-team
/.github/workflows/ @your-username @devops-team

# Configuration requires review
/envs/ @your-username
/docker/ @your-username @devops-team
```

---

## Step 7: Create Environment Secrets Documentation

Create `.github/SECRETS.md`:

```markdown
# Required GitHub Secrets

Configure these in: Settings → Secrets and variables → Actions

## Required Secrets

| Secret | Description | Where to get |
|--------|-------------|--------------|
| `ANTHROPIC_API_KEY` | Anthropic API key | console.anthropic.com |
| `LANGCHAIN_API_KEY` | LangSmith API key | smith.langchain.com |

## Optional Secrets (by deployment target)

### Railway
| Secret | Description |
|--------|-------------|
| `RAILWAY_WEBHOOK_URL` | Deployment webhook |

### Google Cloud Run
| Secret | Description |
|--------|-------------|
| `GCP_SA_KEY` | Service account JSON |
| `GCP_PROJECT_ID` | GCP project ID |

### AWS
| Secret | Description |
|--------|-------------|
| `AWS_ACCESS_KEY_ID` | AWS access key |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key |

## Environment Variables

Configure in: Settings → Environments → [env] → Environment variables

| Variable | Values |
|----------|--------|
| `DEPLOY_TARGET` | `railway`, `cloudrun`, `custom` |
| `STAGING_URL` | https://staging.example.com |
| `PRODUCTION_URL` | https://example.com |
```

---

## Step 8: Commit CI/CD Configuration

```bash
git add .github/
git commit -m "Add CI/CD pipeline with quality gates

- CI workflow with lint, typecheck, tests
- LLM evaluations on main branch
- Staging deployment on push to main
- Production deployment on release
- Branch protection documentation
- CODEOWNERS configuration

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"

git push
```

---

## Output

After completion, provide user with:

1. **CI/CD status badges** for README:
   ```markdown
   ![CI](https://github.com/{org}/{repo}/actions/workflows/ci.yml/badge.svg)
   ```

2. **Required secrets** to configure in GitHub

3. **Branch protection** rules to enable

4. **Next steps**:
   - Configure secrets in GitHub Settings
   - Enable branch protection rules
   - Set up deployment environments (staging, production)
   - Add environment-specific variables
