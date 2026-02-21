#!/bin/bash
#
# Ralph Loop Orchestrator
# Based on Geoffrey Huntley's Ralph Wiggum Technique
#
# Usage:
#   ./loop.sh          # Build mode, unlimited iterations
#   ./loop.sh 20       # Build mode, max 20 iterations
#   ./loop.sh plan     # Plan mode, unlimited
#   ./loop.sh plan 5   # Plan mode, max 5 iterations
#

set -e

# ═══════════════════════════════════════════════════════════════════
# SECURITY NOTICE
# ═══════════════════════════════════════════════════════════════════
# Do NOT use --dangerously-skip-permissions in this loop.
# Claude's permission system is a critical safety layer for
# autonomous iteration. Bypassing it removes guardrails that
# prevent destructive actions during unattended execution.
#
# If you need additional flags, set RALPH_EXTRA_FLAGS in your
# environment. This variable is intentionally NOT set by default
# to prevent accidental misuse.
# ═══════════════════════════════════════════════════════════════════

# ═══════════════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════════════

MODEL="${RALPH_MODEL:-sonnet}"            # Default model
LOG_FILE="${RALPH_LOG:-ralph.log}"        # Iteration log
PROGRESS_FILE="progress.txt"              # Progress tracking
EXTRA_FLAGS="${RALPH_EXTRA_FLAGS:-}"      # User-supplied extra flags (empty by default)

# ═══════════════════════════════════════════════════════════════════
# TEAM MODE CONFIGURATION
# ═══════════════════════════════════════════════════════════════════
# When TEAM_MODE=true, each iteration spawns a 3-member team:
#   1. Explorer  - researches approaches and strategies
#   2. Builder   - implements the approach from explorer's output
#   3. Verifier  - runs tests and validates builder's changes
#
# Each team exists only within its iteration (preserving Ralph's
# fresh-context-per-iteration principle). Git push only happens
# if the verifier passes. Falls back to single-agent mode when
# TEAM_MODE is unset or false.
#
# Usage:
#   TEAM_MODE=true ./loop.sh 10
#   TEAM_MODE=true RALPH_MODEL=opus ./loop.sh plan 5
# ═══════════════════════════════════════════════════════════════════
TEAM_MODE="${TEAM_MODE:-false}"

# ═══════════════════════════════════════════════════════════════════
# ARGUMENT PARSING
# ═══════════════════════════════════════════════════════════════════

if [ "$1" = "plan" ]; then
  MODE="plan"
  PROMPT_FILE="PROMPT_plan.md"
  MAX_ITERATIONS=${2:-0}
  echo "🔄 Ralph Planning Mode"
elif [[ "$1" =~ ^[0-9]+$ ]]; then
  MODE="build"
  PROMPT_FILE="PROMPT_build.md"
  MAX_ITERATIONS=$1
  echo "🔨 Ralph Building Mode (max $MAX_ITERATIONS iterations)"
else
  MODE="build"
  PROMPT_FILE="PROMPT_build.md"
  MAX_ITERATIONS=0
  echo "🔨 Ralph Building Mode (unlimited iterations)"
fi

if [ "$TEAM_MODE" = "true" ]; then
  echo "👥 Team Mode: ENABLED (explorer -> builder -> verifier per iteration)"
fi

# ═══════════════════════════════════════════════════════════════════
# VALIDATION
# ═══════════════════════════════════════════════════════════════════

if [ ! -f "$PROMPT_FILE" ]; then
  echo "❌ Error: $PROMPT_FILE not found"
  echo "   Copy template from ~/.claude/skills/RalphLoop/Templates/"
  exit 1
fi

if [ ! -d "specs" ]; then
  echo "⚠️  Warning: specs/ directory not found"
  echo "   Ralph works best with detailed specs"
fi

# ═══════════════════════════════════════════════════════════════════
# TEAM MODE HELPER
# ═══════════════════════════════════════════════════════════════════
# Runs a single iteration with a 3-member team (explorer -> builder
# -> verifier). Each member is a fresh claude -p process. Output
# from each stage feeds into the next. Git push only if verifier
# passes. Team manifest is written to a temp directory for
# observability, then cleaned up.
# ═══════════════════════════════════════════════════════════════════

run_team_iteration() {
  local iter_num=$1
  local prompt_content
  prompt_content=$(cat "$PROMPT_FILE")

  # Create team manifest directory for this iteration
  local team_dir
  team_dir=$(mktemp -d "${TMPDIR:-/tmp}/ralph-team-iter${iter_num}-XXXXXX")
  echo "[$(date)] Team directory: $team_dir" >> "$LOG_FILE"

  # ── Stage 1: Explorer ──────────────────────────────────────────
  # Researches approaches based on the prompt and current codebase state
  echo "  🔍 [Explorer] Researching approaches..."
  local explorer_prompt="You are the EXPLORER in a 3-member team iteration. Your job is to research and propose the best approach for this iteration.

Read the current state of the codebase, analyze what needs to be done, and output a clear, actionable plan that a builder agent can follow.

## Task Context
${prompt_content}

## Output Format
Provide:
1. Current state assessment (what exists, what's broken, what's next)
2. Recommended approach (specific files, changes, strategy)
3. Success criteria (how the verifier should validate the work)"

  local explorer_output
  # shellcheck disable=SC2086
  explorer_output=$(echo "$explorer_prompt" | claude -p \
    --output-format=text \
    --model "$MODEL" \
    $EXTRA_FLAGS 2>&1) || true

  echo "$explorer_output" > "$team_dir/explorer-output.txt"
  echo "  ✅ [Explorer] Complete ($(wc -l < "$team_dir/explorer-output.txt") lines)" | tee -a "$LOG_FILE"

  # ── Stage 2: Builder ───────────────────────────────────────────
  # Implements the approach recommended by the explorer
  echo "  🔨 [Builder] Implementing approach..."
  local builder_prompt="You are the BUILDER in a 3-member team iteration. The Explorer has analyzed the codebase and recommended an approach. Your job is to implement it.

## Explorer's Analysis and Plan
${explorer_output}

## Original Task Context
${prompt_content}

## Instructions
- Implement the changes recommended by the Explorer
- Follow the success criteria the Explorer defined
- Commit your changes with a descriptive message
- Do NOT push to remote (the Verifier must validate first)"

  local builder_output
  # shellcheck disable=SC2086
  builder_output=$(echo "$builder_prompt" | claude -p \
    --output-format=text \
    --model "$MODEL" \
    $EXTRA_FLAGS 2>&1) || true

  echo "$builder_output" > "$team_dir/builder-output.txt"
  echo "  ✅ [Builder] Complete ($(wc -l < "$team_dir/builder-output.txt") lines)" | tee -a "$LOG_FILE"

  # ── Stage 3: Verifier ──────────────────────────────────────────
  # Runs tests and validates the builder's changes
  echo "  🧪 [Verifier] Validating changes..."
  local verifier_prompt="You are the VERIFIER in a 3-member team iteration. The Builder has implemented changes based on the Explorer's plan. Your job is to validate everything works.

## Explorer's Plan (what should have been done)
${explorer_output}

## Builder's Report (what was done)
${builder_output}

## Original Task Context
${prompt_content}

## Instructions
1. Run all relevant tests (unit, integration, type checks)
2. Verify the changes match the Explorer's success criteria
3. Check for regressions or broken functionality
4. Output your verdict as the LAST LINE in this exact format:
   VERDICT: PASS
   or
   VERDICT: FAIL - [reason]"

  local verifier_output
  # shellcheck disable=SC2086
  verifier_output=$(echo "$verifier_prompt" | claude -p \
    --output-format=text \
    --model "$MODEL" \
    $EXTRA_FLAGS 2>&1) || true

  echo "$verifier_output" > "$team_dir/verifier-output.txt"
  echo "  ✅ [Verifier] Complete ($(wc -l < "$team_dir/verifier-output.txt") lines)" | tee -a "$LOG_FILE"

  # ── Check verdict and push if passed ────────────────────────────
  local verdict
  verdict=$(echo "$verifier_output" | grep -i "^VERDICT:" | tail -1 || echo "VERDICT: UNKNOWN")

  if echo "$verdict" | grep -qi "PASS"; then
    echo "  ✅ Team iteration $iter_num PASSED" | tee -a "$LOG_FILE"
    if [ "$MODE" = "build" ]; then
      echo "  📤 Pushing verified changes..."
      git push origin "$(git branch --show-current)" 2>/dev/null || echo "   (nothing to push)"
    fi
  else
    echo "  ❌ Team iteration $iter_num FAILED: $verdict" | tee -a "$LOG_FILE"
    echo "     (skipping git push - verifier did not pass)"
  fi

  # Write team iteration summary
  cat > "$team_dir/summary.json" <<TEAMEOF
{
  "iteration": $iter_num,
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "verdict": "$(echo "$verdict" | sed 's/"/\\"/g')",
  "explorer_lines": $(wc -l < "$team_dir/explorer-output.txt"),
  "builder_lines": $(wc -l < "$team_dir/builder-output.txt"),
  "verifier_lines": $(wc -l < "$team_dir/verifier-output.txt")
}
TEAMEOF

  echo "[$(date)] Team iteration $iter_num summary: $verdict" >> "$LOG_FILE"
}

# ═══════════════════════════════════════════════════════════════════
# MAIN LOOP
# ═══════════════════════════════════════════════════════════════════

ITERATION=0
START_TIME=$(date +%s)

echo "═══════════════════════════════════════════════════════════════"
echo "Started: $(date)"
echo "Prompt: $PROMPT_FILE"
echo "Max iterations: ${MAX_ITERATIONS:-unlimited}"
echo "═══════════════════════════════════════════════════════════════"
echo ""

while true; do
  # Check iteration limit
  if [ "$MAX_ITERATIONS" -gt 0 ] && [ "$ITERATION" -ge "$MAX_ITERATIONS" ]; then
    echo ""
    echo "🛑 Max iterations ($MAX_ITERATIONS) reached"
    break
  fi

  ITERATION=$((ITERATION + 1))
  ITER_START=$(date +%s)

  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "📍 Iteration $ITERATION - $(date)"
  echo "═══════════════════════════════════════════════════════════════"
  echo ""

  # Log iteration start
  echo "[$(date)] Iteration $ITERATION started" >> "$LOG_FILE"

  if [ "$TEAM_MODE" = "true" ]; then
    # ── Team Mode: explorer -> builder -> verifier pipeline ──
    run_team_iteration "$ITERATION"
  else
    # ── Standard Mode: single claude -p invocation ──
    # shellcheck disable=SC2086
    cat "$PROMPT_FILE" | claude -p \
      --output-format=stream-json \
      --model "$MODEL" \
      --verbose $EXTRA_FLAGS 2>&1 | tee -a "$LOG_FILE"

    # Push changes if in build mode
    if [ "$MODE" = "build" ]; then
      echo ""
      echo "📤 Pushing changes..."
      git push origin "$(git branch --show-current)" 2>/dev/null || echo "   (nothing to push)"
    fi
  fi

  ITER_END=$(date +%s)
  ITER_DURATION=$((ITER_END - ITER_START))

  # Log iteration end
  echo "[$(date)] Iteration $ITERATION completed (${ITER_DURATION}s)" >> "$LOG_FILE"

  # Append to progress file
  echo "Iteration $ITERATION completed at $(date) (${ITER_DURATION}s)" >> "$PROGRESS_FILE"

  # Small delay between iterations
  sleep 2
done

END_TIME=$(date +%s)
TOTAL_DURATION=$((END_TIME - START_TIME))

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "✅ Ralph Loop Complete"
echo "   Total iterations: $ITERATION"
echo "   Total time: ${TOTAL_DURATION}s"
echo "═══════════════════════════════════════════════════════════════"
