# Sheet Reference

Quick reference for Google Sheets data sources used in context gathering.

## Spreadsheet IDs

| Sheet | Spreadsheet ID | Content |
|-------|---------------|---------|
| alignment | 1LFOEWT6FQPupiyWEAOu9bxwB7C1dLvqAAn-S_fpf69U | Roles, missions, 2026 goals, alignment score |
| goal_achievement | 1iiX2qfRn6Gx1q1yLu5Xu8nV-x7S_KA45gykjgQKTJdw | Q1 WIGs, 6 lead measures, goal tracking |
| habit_building | 1xrGAGvKlgckHbjnMevs9ZhlwtNWaUL5CzzgRQ82X9LA | Daily habits, consistency percentages |
| health | 1cY_1c5pJxyPBiQNlXeYGo9CFAJ8Khl91qQXhyP6ztBc | Health metrics, body composition |
| media_mgmt | 1gmlzlekeGmnsqEgoWFV2MOUsycd-yiiN2wiyc7EQJhE | Media consumption tracking |
| adventure | 1YkElkUpgxE0dSAO17-8L3Zqp5FwYUTR0jbxY1kbBmkE | Travel plans, adventure tracking |
| skill_mastery | 1DWv7VCy-a7lOqAZNWud8aEUDDF0hvtM3rCwUVrCjrTk | Skill development tracking |

## Intent-to-Sheet Mapping

Use this table to determine which sheet(s) to fetch based on user request:

| User Mentions | Fetch From |
|---------------|------------|
| roles, missions, alignment score | alignment |
| goals, 2026 goals, progress | alignment (progress!A75:Z108) |
| WIGs, lead measures, Q1 goals | goal_achievement |
| habits, consistency, tracking | habit_building |
| health, weight, body composition | health |
| media, screen time, consumption | media_mgmt |
| travel, adventure, trips | adventure |
| skills, skill development, mastery | skill_mastery |

## Key Ranges

| Sheet | Range | Content |
|-------|-------|---------|
| alignment | A2:H8 | Role definitions |
| alignment | progress!A75:Z108 | 2026 goals by role |
| alignment | progress!A1:Z120 | Full progress data |
| goal_achievement | A1:Z50 | WIGs and lead measures |
| habit_building | A1:AM50 | Habit tracking data |
| health | A1:Z50 | Health metrics |

## CLI Usage

```bash
# Fetch specific sheet data
kaya-cli sheets get [SPREADSHEET_ID] --range "[RANGE]"

# Examples
kaya-cli sheets get 1LFOEWT6FQPupiyWEAOu9bxwB7C1dLvqAAn-S_fpf69U --range "progress!A75:Z108"
kaya-cli sheets get 1iiX2qfRn6Gx1q1yLu5Xu8nV-x7S_KA45gykjgQKTJdw --range "A1:Z50"
kaya-cli sheets get 1xrGAGvKlgckHbjnMevs9ZhlwtNWaUL5CzzgRQ82X9LA --range "A1:AM50"
```

## Google Drive Folder

**DTR Folder ID:** `1YwEOAblX29O18kTNqqoktetNGD9iX30c`

---

*Reference file for InformationManager workflows. Contains private spreadsheet IDs - never share publicly.*
