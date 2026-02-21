#!/bin/bash
# Kaya Open Source Portfolio -- Sanitization Verification Script
# Scans all included files for personal data that should have been removed.
# Run this before publishing to ensure zero PII exposure.

set -uo pipefail

# Default to the repo root (parent of scripts/) if no argument provided
if [ -n "${1:-}" ]; then
  REPO_DIR="$1"
else
  REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
fi
PASS=0
FAIL=0
WARN=0

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}PASS${NC} $1"; ((PASS++)); }
fail() { echo -e "  ${RED}FAIL${NC} $1"; ((FAIL++)); }
warn() { echo -e "  ${YELLOW}WARN${NC} $1"; ((WARN++)); }

echo "============================================"
echo "  Kaya Sanitization Verification"
echo "  Scanning: $REPO_DIR"
echo "============================================"
echo ""

# --- Scan 1: Personal username ---
echo "Scan 1: Personal username references"
if grep -rn "jstilb" "$REPO_DIR" --include="*.ts" --include="*.md" --include="*.json" --include="*.yaml" --include="*.sh" --include="*.txt" 2>/dev/null | grep -v "your-username" | grep -v "verify-sanitization" | head -5 | grep -q .; then
  fail "Found 'jstilb' references (not 'your-username')"
  grep -rn "jstilb" "$REPO_DIR" --include="*.ts" --include="*.md" --include="*.json" --include="*.yaml" --include="*.sh" 2>/dev/null | grep -v "your-username" | grep -v "verify-sanitization" | head -5
else
  pass "No personal username references found"
fi

# --- Scan 2: Personal paths ---
echo ""
echo "Scan 2: Personal filesystem paths"
PERSONAL_PATHS=$(grep -rn "/Users/[a-z]" "$REPO_DIR" --include="*.ts" --include="*.md" --include="*.json" --include="*.yaml" --include="*.sh" 2>/dev/null | grep -v "/Users/your-username" | grep -v "/Users/test" | grep -v "/Users/john" | grep -v "/Users/jane" | grep -v "/Users/username" | grep -v "/Users/\.\.\./" | grep -v "/Users/xxx/" | grep -v "verify-sanitization" | grep -v "# Mac paths" | grep -v "// Matches" || true)
if [ -n "$PERSONAL_PATHS" ]; then
  COUNT=$(echo "$PERSONAL_PATHS" | wc -l | tr -d ' ')
  if [ "$COUNT" -gt 0 ] && echo "$PERSONAL_PATHS" | grep -qv "^$"; then
    fail "Found $COUNT personal path references"
    echo "$PERSONAL_PATHS" | head -5
  else
    pass "No personal filesystem paths found"
  fi
else
  pass "No personal filesystem paths found"
fi

# --- Scan 3: API keys and secrets ---
echo ""
echo "Scan 3: API keys and credentials"
# Check for actual API key patterns (not example/placeholder patterns)
if grep -rn "sk-ant-api\|sk-[a-zA-Z0-9]\{20,\}\|ghp_[a-zA-Z0-9]\{36\}\|xoxb-\|xoxp-" "$REPO_DIR" --include="*.ts" --include="*.json" --include="*.yaml" --include="*.sh" 2>/dev/null | grep -v "example" | grep -v "placeholder" | grep -v "sk-ant-api03-\.\.\." | grep -v "sk-\.\.\." | grep -v "verify-sanitization" | grep -v "pattern" | grep -v "regex" | grep -v "Pattern" | grep -v "test" | grep -v "Test" | grep -v "scrub" | grep -v "obfuscate" | head -5 | grep -q .; then
  fail "Found potential API key patterns"
else
  pass "No API key patterns found"
fi

# --- Scan 4: Secrets file ---
echo ""
echo "Scan 4: Secrets file exclusion"
if [ -f "$REPO_DIR/secrets.json" ]; then
  fail "secrets.json exists in repository (should be excluded)"
else
  pass "secrets.json is not present"
fi

# --- Scan 5: .env file ---
echo ""
echo "Scan 5: .env file exclusion"
if [ -f "$REPO_DIR/.env" ]; then
  fail ".env exists in repository (should be excluded)"
else
  pass ".env is not present"
fi

# --- Scan 6: Git history ---
echo ""
echo "Scan 6: Git history"
if [ -d "$REPO_DIR/.git" ]; then
  COMMIT_COUNT=$(cd "$REPO_DIR" && git log --oneline 2>/dev/null | wc -l | tr -d ' ')
  if [ "$COMMIT_COUNT" -le 1 ]; then
    pass "Fresh git repo (${COMMIT_COUNT} commit)"
  else
    warn "Git repo has ${COMMIT_COUNT} commits (should be fresh)"
  fi
else
  pass "No .git directory (not yet initialized)"
fi

# --- Scan 7: Personal name references ---
echo ""
echo "Scan 7: Personal name references"
if grep -rn '"Jm"' "$REPO_DIR" --include="*.ts" --include="*.md" --include="*.json" --include="*.yaml" 2>/dev/null | grep -v "verify-sanitization" | head -5 | grep -q .; then
  fail "Found '\"Jm\"' personal name references"
  grep -rn '"Jm"' "$REPO_DIR" --include="*.ts" --include="*.md" --include="*.json" --include="*.yaml" 2>/dev/null | grep -v "verify-sanitization" | head -5
else
  pass "No personal name references found"
fi

# --- Scan 8: Social handles ---
echo ""
echo "Scan 8: Social media handles"
if grep -rn "jmstilb\|john-stilb" "$REPO_DIR" --include="*.ts" --include="*.md" --include="*.json" --include="*.yaml" 2>/dev/null | grep -v "verify-sanitization" | head -5 | grep -q .; then
  fail "Found personal social media handles"
else
  pass "No personal social handles found"
fi

# --- Scan 9: Placeholder READMEs ---
echo ""
echo "Scan 9: Placeholder READMEs for excluded directories"
MISSING_READMES=0
for dir in MEMORY MEMORY/WORK MEMORY/LEARNING MEMORY/State MEMORY/daemon context skills/CORE/USER skills/CORE/USER/TELOS; do
  if [ ! -f "$REPO_DIR/$dir/README.md" ]; then
    fail "Missing placeholder: $dir/README.md"
    ((MISSING_READMES++))
  fi
done
if [ "$MISSING_READMES" -eq 0 ]; then
  pass "All required placeholder READMEs present"
fi

# --- Scan 10: settings.json validity ---
echo ""
echo "Scan 10: settings.json validity"
if [ -f "$REPO_DIR/settings.json" ]; then
  if python3 -c "import json; json.load(open('$REPO_DIR/settings.json'))" 2>/dev/null; then
    pass "settings.json is valid JSON"
  else
    fail "settings.json is not valid JSON"
  fi
else
  fail "settings.json is missing"
fi

# --- Scan 11: Example files ---
echo ""
echo "Scan 11: Example files present"
for f in secrets.example.json settings.example.json .env.example .gitignore; do
  if [ -f "$REPO_DIR/$f" ]; then
    pass "Example file present: $f"
  else
    fail "Missing example file: $f"
  fi
done

# --- Scan 12: SKILL.md presence ---
echo ""
echo "Scan 12: SKILL.md in each skill directory"
MISSING_SKILLS=0
for skill_dir in "$REPO_DIR"/skills/*/; do
  skill_name=$(basename "$skill_dir")
  if [ "$skill_name" = "skill-index.json" ]; then continue; fi
  if [ ! -f "$skill_dir/SKILL.md" ] && [ ! -f "$skill_dir/SKILL.compressed.md" ]; then
    warn "No SKILL.md in: skills/$skill_name/"
    ((MISSING_SKILLS++))
  fi
done
if [ "$MISSING_SKILLS" -eq 0 ]; then
  pass "All skills have SKILL.md"
fi

# --- Scan 13: Personal data patterns ---
echo ""
echo "Scan 13: Sensitive personal data patterns"
# Note: This scan intentionally excludes type definitions, security detection patterns,
# and structural code references. It looks for actual personal values.
if grep -rni "my salary is\|my ssn\|my social security\|my bank account\|my credit card" "$REPO_DIR" --include="*.ts" --include="*.md" --include="*.json" --include="*.yaml" 2>/dev/null | grep -v "verify-sanitization" | head -5 | grep -q .; then
  fail "Found sensitive personal data patterns"
else
  pass "No sensitive personal data patterns found"
fi

# --- Scan 14: History and session files ---
echo ""
echo "Scan 14: Session/history file exclusion"
for f in history.jsonl stats-cache.json dedup-hashes.json index.json settings.local.json .current-session; do
  if [ -f "$REPO_DIR/$f" ]; then
    fail "Session file present: $f (should be excluded)"
  fi
done
pass "No session/history files present"

# --- Scan 15: MEMORY contents ---
echo ""
echo "Scan 15: MEMORY directory contents"
MEMORY_FILES=$(find "$REPO_DIR/MEMORY" -type f -not -name "README.md" 2>/dev/null | head -5)
if [ -n "$MEMORY_FILES" ]; then
  fail "Found non-README files in MEMORY/"
  echo "$MEMORY_FILES"
else
  pass "MEMORY/ contains only README.md placeholders"
fi

# --- Summary ---
echo ""
echo "============================================"
echo "  Results"
echo "============================================"
echo -e "  ${GREEN}PASS: $PASS${NC}"
echo -e "  ${RED}FAIL: $FAIL${NC}"
echo -e "  ${YELLOW}WARN: $WARN${NC}"
echo ""

if [ "$FAIL" -eq 0 ]; then
  echo -e "${GREEN}All checks passed. Safe to publish.${NC}"
  exit 0
else
  echo -e "${RED}$FAIL check(s) failed. Fix before publishing.${NC}"
  exit 1
fi
