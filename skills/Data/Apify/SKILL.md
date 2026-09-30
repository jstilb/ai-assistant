---
name: Apify
description: Apify actor-run and dataset client — EventScout's JS-rendering/Cloudflare-bypass fetch tier. USE WHEN Apify actor run, Apify dataset, EventScout Apify fetch tier, calling Apify's API directly in code.
context: fork
---
## Voice Notification

-> Use `notifySync()` from `lib/core/NotificationService.ts`

**When executing a workflow, output this notification directly:**

```
Running the **WorkflowName** workflow in the **Apify** skill to ACTION...
```

# Apify - EventScout's Apify fetch client

`index.ts` exports the `Apify`/`ApifyDataset` client — a thin TypeScript
wrapper around the Apify platform's actor-run and dataset APIs. It is **LIVE**:
EventScout's `skills/Productivity/EventScout/Tools/adapters/ApifyAdapter.ts`
imports it directly (`cross-skill-allowed`) as a cron-wired fetch tier for 2
sources (`sandiego-org-events`, `bandsintown-sd`) that need JS rendering +
Cloudflare bypass and can't run through BrightData's keyless tiers unattended.
That nightly cron run is the only thing this skill currently serves.

If you're here because something scrapes JS-heavy pages for EventScout, this
is the right place — see `ApifyAdapter.ts` for the calling convention (`new
Apify(token)`, `apify.callActor(...)`, `apify.getDataset(...)`,
`dataset.listItems(...)`).

## API reference

See `README.md` in this directory for the full `Apify`/`ApifyDataset` API
(constructor, `callActor`, `getDataset`, `getRun`, `waitForRun`, `listItems`,
`getAllItems`, `filter`, `top`) and usage patterns.

## Configuration

**Environment Variables:**
```bash
# Required — canonical env var, no fallback
APIFY_TOKEN=apify_api_xxxxx...
```

## History

This skill previously also shipped a 9-actor preset library (Instagram,
LinkedIn, TikTok, YouTube, Facebook, Google Maps, Amazon, generic web
scraping) plus a CLI and example scripts. It had zero consumers from
creation (2026-03-03) through deletion and was removed as dead code — see
`plans/audits/remediation/theme3-apify-wrapper-kill.md` (decision: kill,
`00-decisions-log.md:15`) for the full accounting and rationale. Recovery
via git history if platform-specific structured scraping is ever wanted
again; BrightData's `scrape_as_markdown`/`mcp__Brightdata__*` tools cover
general ad-hoc scraping needs in the meantime.
