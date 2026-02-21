# Research Skill Configuration

> **Note:** These YAML blocks are reference documentation for agent behavior, not machine-parsed config. Values here should match the corresponding workflow files.

## Research Modes

```yaml
research:
  # Default mode when user says "do research" without specifying
  default_mode: standard

  # Mode-specific settings
  modes:
    quick:
      agents: 1
      timeout_seconds: 30
      agent_types: [ClaudeResearcher]

    standard:
      agents: 2
      timeout_seconds: 60
      agent_types: [ClaudeResearcher, GeminiResearcher]

    extensive:
      agents: 9
      timeout_seconds: 300
      agent_types: [ClaudeResearcher, GeminiResearcher, GrokResearcher]
      agents_per_type: 3
```

## URL Verification

```yaml
url_verification:
  # Whether URL verification is required before output
  required: true

  # Timeout for URL verification requests (ms)
  timeout_ms: 10000

  # Skip verification for these domains (trusted sources)
  trusted_domains:
    - wikipedia.org
    - github.com
    - arxiv.org
    - nature.com
    - science.org
```

## Content Retrieval

```yaml
retrieval:
  # Layer escalation settings
  layers:
    layer1:
      tools: [WebFetch, WebSearch]
      timeout_seconds: 10

    layer2:
      tools: [BrightData]
      timeout_seconds: 30
      trigger_on: [403, 429, 503, empty_content]

    layer3:
      tools: [Apify]
      timeout_seconds: 60
      trigger_on: layer2_failure
```

## ExtractAlpha Settings

```yaml
extract_alpha:
  # Number of insights to generate
  insight_count: 24-30

  # Maximum words per bullet
  bullet_max_words: 12

  # Analysis dimensions to apply
  dimensions:
    - SURFACE_SCAN
    - DEPTH_PROBE
    - CONNECTION_MAP
    - ASSUMPTION_CHALLENGE
    - NOVELTY_DETECTION
    - FRAMEWORK_EXTRACTION
    - SUBTLE_INSIGHTS
    - CONTRARIAN_ANGLES
    - FUTURE_IMPLICATIONS
    - SYNTHESIS
```

## Output Settings

```yaml
output:
  # Where to save research artifacts during work
  scratch_dir: "~/.claude/MEMORY/WORK/{current_work}/scratch/"

  # Where to save permanent research outputs
  history_dir: "~/.claude/History/research/YYYY-MM/YYYY-MM-DD_[topic]/"

  # Include sources in output
  include_sources: true

  # Verify all URLs before including
  verify_urls: true
```

## Rate Limiting

```yaml
rate_limits:
  # Maximum concurrent agent spawns
  max_parallel_agents: 9

  # Cooldown between extensive research runs (seconds)
  extensive_cooldown: 60

  # BrightData/Apify daily request budget
  paid_api_daily_limit: 100
```
