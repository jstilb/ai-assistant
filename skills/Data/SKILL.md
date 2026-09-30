---
name: Data
description: Apify actor-run/dataset client, BrightData data collection, web assessment, and data science. USE WHEN scrape, web scraping, apify, bright data, brightdata, web assessment, data collection, data extraction, analyze a dataset, explore data, data profiling, summary statistics, correlation, hypothesis test, t-test, ANOVA, chi-square, regression, OR statistical analysis.
---

# Data

Data collection, web assessment, and data science — covering Apify's actor-run/dataset client (EventScout's fetch tier), BrightData structured data collection, web property assessment, and statistical analysis / modeling of tabular datasets.

## Sub-Skills

| Sub-Skill | Triggers | Load |
|-----------|----------|------|
| **Apify** | apify actor run, apify dataset, eventscout apify fetch tier, calling apify's api directly in code | `Data/Apify/SKILL.md` |
| **BrightData** | bright data, scrape url, web scraping tiers, serp api, linkedin scraping, bot-blocked content, proxy scraping | `Data/BrightData/SKILL.md` |
| **DataScience** | analyze a dataset, explore data, data profiling, summary statistics, distribution, missing values, outliers, correlation, correlate columns, hypothesis test, t-test, anova, chi-square, statistical significance, p-value, regression, linear regression, logistic regression, predict, or model a relationship in data | `Data/DataScience/SKILL.md` |
| **WebAssessment** | web assessment, pentest, security testing, vulnerability scan, osint recon, bug bounty, threat model, nuclei scan, security audit | `Data/WebAssessment/SKILL.md` |

## Workflow Routing

When a sub-skill is identified from the table above:
1. Read the sub-skill's SKILL.md for its full routing and workflow list
2. Execute the appropriate workflow from that sub-skill's directory

## Voice Notification

Use `notifySync()` from `lib/core/NotificationService.ts`
