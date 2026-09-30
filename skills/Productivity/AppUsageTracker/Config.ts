/**
 * AppUsageTracker — central config.
 *
 * Edit `devices[].baseUrl` Tailscale IPs after Phase 1 (`tailscale ip -4` per device).
 * Edit tier lists to refine classification. Run `MetricCalc.ts --force` to recompute.
 */

export interface DeviceConfig {
  name: "mac" | "phone" | "tablet";
  baseUrl: string;
}

export interface AdbDevice {
  serial: string;
  name: "phone" | "tablet";
  localPort: number;
}

/**
 * Per-(device, app) floor in minutes/day. Subtracted from Tier-1 contribution
 * before summing. Clamped at 0 — a low-use day won't go negative. Use this for
 * apps that have a healthy baseline you want to ignore (e.g. Chess up to 10
 * min/day is fine, only count the excess).
 *
 * `device` is required to keep matches unambiguous; add multiple entries if a
 * floor applies on multiple devices. Matched case-insensitively on `app`.
 */
export interface Tier1Floor {
  device: DeviceName;
  app: string;
  floorMin: number;
}

export type DeviceName = "mac" | "phone" | "tablet";

export interface AppUsageConfig {
  dbPath: string;
  devices: DeviceConfig[];
  adbDevices: AdbDevice[];
  tier1Apps: string[];
  tier1AppsByDevice: Partial<Record<DeviceName, string[]>>;
  tier1DomainPatterns: string[];
  tier1FloorsMinPerDay: Tier1Floor[];
  tier2Apps: string[];
  tier2DomainPatterns: string[];
  /** Per-app low-value FRACTION for Tier-2 apps that cannot be title-classified.
   *  Android exposes only the package name (no window title/url), so the LLM
   *  session classifier has nothing to judge. Instead MetricCalc counts
   *  `phone/tablet app_minutes × fraction` as low-value. Keyed by lowercase
   *  app/package name. Apps deemed 0% low-value are simply omitted (they then
   *  contribute nothing). Heuristic apps are also auto-suppressed from the
   *  unclassifiable alarm — see tier2AltCountedApps. */
  tier2HeuristicFractions: Record<string, number>;
  /** Lowercase app/package names whose unclassifiable sessions must NOT trip the
   *  "100% unclassifiable" alarm, because their low-value time is already counted
   *  by another path (YouTube → watch history) or deliberately deemed not
   *  low-value (WhatsApp/Messages = utility). Apps in tier2HeuristicFractions are
   *  added to this set automatically. The alarm then fires only on a genuine
   *  regression — a title-bearing source (e.g. a future desktop watcher) going
   *  dark — instead of every night on metadata-less phone apps. */
  tier2AltCountedApps: string[];
  tier3Apps: string[];
  /** Chrome utility allowlist — domains (exact match on extracted host, e.g.
   * "mail.google.com") that ChromeClassifier short-circuits as not-low-value
   * without calling the LLM. Adding a domain here both saves LLM cost AND
   * prevents misclassification of clearly-work tools.
   *
   * Tier-1 chrome domain patterns (reddit.com etc.) take precedence — those
   * are checked first in ChromeClassifier. */
  chromeUtilityDomains: string[];
  goalStartDate: string;
  pollFetchLimit: number;
  /** IANA tz name used to bucket events into calendar days. Events arrive in
   *  UTC; without this, late-evening PDT activity gets attributed to tomorrow. */
  localTimezone: string;
}

const HOME = process.env.HOME ?? "/Users/[user]";

export const CONFIG: AppUsageConfig = {
  dbPath: `${HOME}/.claude/MEMORY/AppUsage/events.db`,

  devices: [
    { name: "mac", baseUrl: "http://localhost:5600" },
    // Phone + tablet: AW Android v0.12.1 binds aw-server-rust to 127.0.0.1 only
    // and the APK isn't debuggable, so we can't push a config override. We use
    // per-device `adb forward` over USB: phone → :5601, tablet → :5602. The
    // DeviceAutoPoll daemon (PhoneAutoPoll.ts) sets the forward up the moment
    // each device plugs in, dispatching by serial via `adbDevices` below.
    { name: "phone", baseUrl: process.env.AW_PHONE_URL ?? "http://localhost:5601" },
    { name: "tablet", baseUrl: process.env.AW_TABLET_URL ?? "http://localhost:5602" },
  ],

  // Serial → device map used by PhoneAutoPoll.ts. Run `adb devices` to see
  // serials. Adding a new device = append here + plug in over USB. Unknown
  // serials are logged and ignored (won't be polled).
  adbDevices: [
    { serial: "32281JEHN11329", name: "phone", localPort: 5601 },
    { serial: "R52N816X3LH", name: "tablet", localPort: 5602 },
  ],

  // Tier 1 — always low-value. From GOALS.md G37 verbatim. 100% counted.
  // App identifiers cover Mac window-titles, Android package names, and common alt names.
  // NOTE on YouTube: deliberately NOT in Tier-1. YouTube needs per-video
  // metadata to distinguish tutorials/educational from entertainment; that
  // pipeline is built in YouTubeHistory.ts (writes to `classifications` like
  // Classifier.ts does for Tier-2). Until that pipeline is running, YouTube
  // minutes are visible in the dashboard's top-apps view but uncounted.
  tier1Apps: [
    // Reddit
    "com.reddit.frontpage",
    "com.reddit.app",
    "Reddit",
    "reddit",
    // Bluesky
    "xyz.blueskyweb.app",
    "bsky.app",
    "Bluesky",
    "bluesky",
    // X/Twitter
    "com.twitter.android",
    "com.x.android",
    "Twitter",
    "X",
    "twitter",
    // Streaming / video platforms — pure entertainment, no signal-distinguishable
    // educational case on these. (YouTube intentionally absent — see note above.)
    "Netflix",
    "com.netflix.mediaclient",
    "HBO Max",
    "com.wbd.stream",
    "Max",
    "Prime Video",
    "com.amazon.avod.thirdpartyclient",
    "Amazon Prime Video",
    "Disney+",
    "com.disney.disneyplus",
    "Crunchyroll",
    "com.crunchyroll.crunchyroid",
    "Emby",
    "tv.emby.embyatv",
    "tv.emby.mobile",
    "Dropout",
    "com.dropout.dropout",
    "Apple TV",
    "com.apple.atve.androidtv.appletv",
    "tv.apple.atv",
    // Chess — Jm's call: counts as media; healthy baseline subtracted via
    // tier1FloorsMinPerDay (Chess phone floor = 10 min/day).
    "Chess",
    "Chess.com",
    "com.chess",
    "Lichess",
    "com.lichess.mobileapp",
  ],

  // Device-restricted Tier-1 apps. Use for apps that are pure-entertainment on
  // ONE device but legitimate-work on another (Mac Chrome → could be anything;
  // phone Chrome → ~95% Reddit per Jm's read).
  //
  // 2026-05-12 status: phone Chrome STAYS here as a heuristic because the
  // V1.6 ChromeIngest pipeline only reaches the Mac's local SQLite, and Chrome
  // sync is not replicating phone visits into it (originator_cache_guid is
  // empty for all rows on Jm's profile). When real phone-URL data lands (via
  // Google Takeout Chrome history or otherwise), remove the entries below AND
  // the matching tier1FloorsMinPerDay rows.
  tier1AppsByDevice: {
    phone: [
      "Chrome",
      "com.android.chrome",
    ],
  },

  // URL substrings flagged as Tier 1 when seen by aw-watcher-web on Mac browsers.
  // Use SQL LIKE patterns ('%' = wildcard). Keep loose — false-positives in
  // browser tabs are rare for these domains.
  tier1DomainPatterns: [
    "%reddit.com%",
    "%bsky.app%",
    "%twitter.com%",
    "%x.com%",
  ],

  // Per-(device, app) daily floor subtracted from Tier-1 minutes.
  // - Chess phone: Jm considers up to 10 min/day cognitive/healthy.
  // - Chrome phone: assumed ~95% Reddit; ~10 min/day is legitimate utility
  //   browsing (maps fallback, banking, etc.). Exact floor revisited once
  //   Android Chrome history extraction lands.
  // No floor for Mac Chrome — Mac Chrome is excluded from Tier-1 entirely by
  // the device='phone' restriction enforced in MetricCalc (see comment there).
  tier1FloorsMinPerDay: [
    { device: "phone", app: "Chess", floorMin: 10 },
    { device: "phone", app: "Chess.com", floorMin: 10 },
    { device: "phone", app: "com.chess", floorMin: 10 },
    { device: "phone", app: "Lichess", floorMin: 10 },
    { device: "phone", app: "com.lichess.mobileapp", floorMin: 10 },
    { device: "phone", app: "Chrome", floorMin: 10 },
    { device: "phone", app: "com.android.chrome", floorMin: 10 },
  ],

  // Tier 2 — mixed-value. LLM classifier (V1.5) decides per session for sessions
  // with titles/URLs. Sessions without classifiable signal (e.g. Chess on phone,
  // which has no title) effectively don't count — Tier-2 here means "surface on
  // the dashboard so I notice it", not "auto-count toward the goal".
  tier2Apps: [
    // Video platforms — YouTube intentionally kept here for the metadata
    // pipeline (see tier1Apps note). Once YouTubeHistory.ts writes per-video
    // classifications, MetricCalc's Tier-2 join picks them up.
    "YouTube",
    "com.google.android.youtube",
    "Nebula",
    // Mac browsers REMOVED (V1.6) — Chrome time is now sourced exclusively from
    // chrome_visits + chrome_domain_verdicts via MetricCalc.computeChromeLowValueMinutes.
    // Re-adding "Google Chrome"/"Chrome" here would double-count: aw-watcher
    // window events would feed the Classifier-based tier-2 path AND the same
    // wall-clock minutes would also be classified by the URL-based Chrome
    // pipeline. Phone Chrome stays in tier1AppsByDevice for the heuristic until
    // a real phone-URL source materialises (see project_chrome_sync_absence.md).
    // Podcasts (mixed by show topic)
    "Pocket Casts",
    "Overcast",
    "Spotify Podcasts",
    // LinkedIn (feed-scroll vs networking, mixed)
    "LinkedIn",
    "com.linkedin.android",
    // Messaging — utility AND doomchat (per Jm's 2026-05-03 call)
    "WhatsApp",
    "com.whatsapp",
    "Messages",
    "com.google.android.apps.messaging",
  ],

  tier2DomainPatterns: [
    "%youtube.com%",
    "%nebula.tv%",
  ],

  // Heuristic low-value fractions for phone apps with no classifiable metadata
  // (Android exposes only the package name). Jm-set 2026-06-16:
  tier2HeuristicFractions: {
    // Nebula = curated video platform; no Takeout watch-history feed, so it
    // can't use the YouTube consumption path. Jm's call: assume the same
    // low-value share as YouTube's measured consumed-minute fraction (~49%,
    // from historical daily_metrics).
    "nebula": 0.49,
    // LinkedIn mobile is overwhelmingly passive feed-scroll for Jm (not active
    // networking/job-search) → 0.80.
    "linkedin": 0.80,
    "com.linkedin.android": 0.80,
    // WhatsApp + Messages are relational/utility (logistics, 2FA, family) →
    // 0% low-value, so they are intentionally omitted here. They are still
    // listed in tier2AltCountedApps so they don't trip the alarm.
  },
  // Apps whose unclassifiable sessions are EXPECTED (counted elsewhere or deemed
  // not-low-value) and must not trip the unclassifiable alarm. Heuristic apps
  // (Nebula/LinkedIn) are added automatically; list only the others here.
  tier2AltCountedApps: [
    "youtube", "com.google.android.youtube",          // counted via watch history
    "whatsapp", "com.whatsapp",                        // 0% low-value (utility)
    "messages", "com.google.android.apps.messaging",   // 0% low-value (utility)
  ],

  // Tier 3 — explicitly ignored. Never counted regardless of duration.
  tier3Apps: [
    "Maps",
    "com.google.android.apps.maps",
    "Music",
    "Apple Music",
    "Spotify",
    "com.spotify.music",
    // System / launcher noise
    "Pixel Launcher",
    "com.google.android.apps.nexuslauncher",
    "One UI Home",
    "com.sec.android.app.launcher",
    // Call handler — utility, not media
    "Phone",
    "com.google.android.dialer",
  ],

  // Chrome utility-allowlist — short-circuits ChromeClassifier without LLM cost.
  // Match against the extracted host (lowercased, leading 'www.' stripped only
  // when at least one more label follows; see extractDomain in ChromeIngest).
  // Keep narrow — only domains that are unambiguously work/utility. Mixed-use
  // (linkedin.com, news.google.com, etc.) goes to the LLM.
  chromeUtilityDomains: [
    // Google Workspace
    "mail.google.com",
    "calendar.google.com",
    "docs.google.com",
    "drive.google.com",
    "sheets.google.com",
    "slides.google.com",
    "forms.google.com",
    "meet.google.com",
    "chat.google.com",
    "gemini.google.com",
    "notebooklm.google.com",
    "voice.google.com",
    // Anthropic / Claude
    "claude.ai",
    "console.anthropic.com",
    "anthropic.com",
    // Cloud consoles
    "console.cloud.google.com",
    "console.firebase.google.com",
    "supabase.com",
    "app.supabase.com",
    "vercel.com",
    "cloudflare.com",
    "dash.cloudflare.com",
    // Dev tooling / reference
    "github.com",
    "gist.github.com",
    "gitlab.com",
    "stackoverflow.com",
    "developer.mozilla.org",
    "npmjs.com",
    "www.npmjs.com",
    "bun.sh",
    "duckdb.org",
    "typescriptlang.org",
    "www.typescriptlang.org",
    "react.dev",
    // Productivity / SaaS
    "linear.app",
    "notion.so",
    "www.notion.so",
    "obsidian.md",
    "stripe.com",
    "dashboard.stripe.com",
    "tailscale.com",
    "login.tailscale.com",
    // Banking / utility
    "healthsafe-id.com",
    "care.headway.co",
    // Localhost / dev
    "localhost",
    "127.0.0.1",
  ],

  // G37 quarter start. MetricCalc backfills daily_metrics from this date.
  goalStartDate: "2026-04-27",

  // Per-bucket fetch cap per poll. AW REST default behavior is to return
  // newest-first; we use start=<last_event_ts> to limit to the new tail.
  pollFetchLimit: 10000,

  // Local timezone for date bucketing. aw-server emits UTC; without this,
  // events between 5pm-midnight PDT were getting attributed to tomorrow's
  // metric. See MetricCalc.localDate() for usage.
  localTimezone: "America/Los_Angeles",
};

/**
 * Returns true if a device's baseUrl looks usable (not a 100.0.0.0 placeholder).
 * Phone/tablet devices use `localhost:<port>` populated by `adb forward` while
 * USB-connected; AWPoller still attempts the fetch and fails-soft if the
 * forward isn't currently active.
 */
export function isDeviceReady(device: DeviceConfig): boolean {
  if (device.name === "mac") return true;
  return !device.baseUrl.includes("100.0.0.0");
}
