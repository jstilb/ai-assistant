#!/bin/bash
# kaya-autoinfo.sh - Shell runner for AutoInfoManager
#
# Usage:
#   kaya-autoinfo.sh --tier daily
#   kaya-autoinfo.sh --tier weekly
#   kaya-autoinfo.sh --tier monthly
#   kaya-autoinfo.sh --status
#   kaya-autoinfo.sh --errors

exec bun ~/.claude/skills/AutoInfoManager/Tools/AutoInfoRunner.ts "$@"
