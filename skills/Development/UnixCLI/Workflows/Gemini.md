# Gemini Workflow (gemini-cli)

Gemini AI operations via gemini-cli.

## Prerequisites

- gemini-cli installed (`kaya-cli gemini --version`)
- Gemini API key configured
- Key stored in environment or secrets.json

## Authentication

```bash
# Set API key
export GEMINI_API_KEY="your-api-key"

# Add to ~/.zshrc for persistence
echo 'export GEMINI_API_KEY="your-api-key"' >> ~/.zshrc

# Or store in secrets.json (recommended)
# ~/.claude/secrets.json:
# {
#   "GEMINI_API_KEY": "your-api-key"
# }
```

Get API key at: https://makersuite.google.com/app/apikey

## Common Operations

### Simple Queries

```bash
# Basic query
kaya-cli gemini "What is quantum computing?"

# Multi-line query
kaya-cli gemini "Explain the following:
1. Machine learning basics
2. Neural networks
3. Deep learning"

# From stdin
echo "Summarize this text: ..." | kaya-cli gemini
```

### Code Operations

```bash
# Explain code
kaya-cli gemini "Explain this code: $(cat script.js)"

# Generate code
kaya-cli gemini "Write a Python function to calculate factorial"

# Code review
cat myfile.py | kaya-cli gemini "Review this code for bugs and improvements"
```

### Content Generation

```bash
# Generate text
kaya-cli gemini "Write a professional email about project delay"

# Summarize content
curl -s https://example.com/article | kaya-cli gemini "Summarize this article"

# Create outline
kaya-cli gemini "Create an outline for a presentation on AI ethics"
```

### Analysis

```bash
# Analyze data
cat data.csv | kaya-cli gemini "Analyze this data and provide insights"

# Compare options
kaya-cli gemini "Compare PostgreSQL vs MongoDB for a web application"

# Extract information
cat document.txt | kaya-cli gemini "Extract all email addresses from this text"
```

## Output Formats

**Plain text** (default):
```bash
kaya-cli gemini "query"
```

**Structured output**:
Use prompting to request specific formats:
```bash
kaya-cli gemini "List top 3 programming languages. Output as JSON array."
```

## Integration Examples

### Automated code review
```bash
# Review all changed files
git diff HEAD^ HEAD | kaya-cli gemini "Review these code changes for issues"
```

### Documentation generation
```bash
# Generate README from code
cat main.py | kaya-cli gemini "Generate a README.md for this code"
```

### Content processing pipeline
```bash
# Extract, summarize, and format
curl -s URL | \
    kaya-cli gemini "Extract main points" | \
    kaya-cli gemini "Format as bullet points"
```

### Question answering
```bash
# Answer questions about local files
question="What does this config do?"
cat config.json | kaya-cli gemini "$question"
```

## Error Handling

```bash
if ! kaya-cli gemini "test" &> /dev/null; then
    echo "Gemini API access failed"
    echo "Check API key: echo \$GEMINI_API_KEY"
    exit 1
fi
```

Common errors:
- **Authentication failed**: Check API key
- **Rate limiting**: Add delays between requests
- **Token limit exceeded**: Reduce input size

## Advanced Options

```bash
# Specify model
kaya-cli gemini --model gemini-pro "query"

# Set temperature (creativity)
kaya-cli gemini --temperature 0.7 "creative task"

# Set max tokens
kaya-cli gemini --max-tokens 500 "query"

# System instructions
kaya-cli gemini --system "You are a code expert" "review this code"
```

## Use Cases

### 1. Code Assistant

```bash
# Generate tests
cat function.js | kaya-cli gemini "Generate Jest tests for this function"

# Refactor code
cat old-code.py | kaya-cli gemini "Refactor this using modern Python patterns"

# Debug assistance
cat error.log | kaya-cli gemini "Explain this error and suggest fixes"
```

### 2. Content Creation

```bash
# Blog post generation
kaya-cli gemini "Write a blog post about async/await in JavaScript"

# Email templates
kaya-cli gemini "Write a professional follow-up email after a meeting"

# Documentation
kaya-cli gemini "Create API documentation for: $(cat api.js)"
```

### 3. Data Analysis

```bash
# CSV analysis
cat sales-data.csv | kaya-cli gemini "Analyze sales trends and provide recommendations"

# Log analysis
cat server.log | kaya-cli gemini "Find patterns and anomalies in these logs"
```

### 4. Translation & Formatting

```bash
# Translation
kaya-cli gemini "Translate to Spanish: Hello, how are you?"

# Format conversion
cat data.json | kaya-cli gemini "Convert this JSON to YAML"

# Markdown formatting
kaya-cli gemini "Format this as a markdown table: ..."
```

## Performance

- Simple queries: < 2s
- Code analysis: 2-5s depending on size
- Long-form generation: 5-10s
- Rate limits: Check API quota

## Prompt Engineering Tips

### Be Specific
```bash
# Vague
kaya-cli gemini "improve this code"

# Specific
kaya-cli gemini "Improve error handling and add type hints to this Python code"
```

### Provide Context
```bash
# Better results with context
kaya-cli gemini "Given this is a React component, suggest performance optimizations: $(cat Component.jsx)"
```

### Request Format
```bash
# Specify output format
kaya-cli gemini "List 5 best practices for X. Format as numbered list."
```

## Best Practices

1. **Cache results**: Don't re-query for same input
2. **Batch operations**: Group similar queries
3. **Handle rate limits**: Add delays in loops
4. **Validate output**: Don't blindly trust generated code
5. **Monitor costs**: Track API usage

## Pipe Composition

```bash
# Chain with other tools
cat file.txt | \
    kaya-cli gemini "Extract key points" | \
    kaya-cli gemini "Create action items" | \
    tee summary.txt

# Process multiple files
find . -name "*.md" -exec sh -c \
    'cat {} | kaya-cli gemini "Summarize" > {}.summary' \;
```

## Documentation

- API reference: https://ai.google.dev/docs
- Models: https://ai.google.dev/models
- Pricing: https://ai.google.dev/pricing
- Gemini CLI: Check `kaya-cli gemini --help`
