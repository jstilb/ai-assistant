#!/bin/bash
input=$(cat)

MODEL=$(echo "$input" | jq -r '.model.display_name // "Unknown"')
PERCENT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | xargs printf "%.0f")
IN_TOKENS=$(echo "$input" | jq -r '.context_window.total_input_tokens // 0')
OUT_TOKENS=$(echo "$input" | jq -r '.context_window.total_output_tokens // 0')

echo "[$MODEL] Context: ${PERCENT}% | IN:${IN_TOKENS} OUT:${OUT_TOKENS}"
