/**
 * Board.ts — the ranked, filterable rental board + its JSON API.
 *
 * Mounted on the LifeOS dashboard (:31337) at /rentals via handleRentalsRoute();
 * also runnable standalone (`RentalTracker.ts serve`).
 *
 *   GET  /rentals                 the board (filters + sort + decisions, all client-side)
 *   GET  /api/rentals             {rows, runs, criteria} — same data the page renders
 *   GET  /api/rentals/help        this API, described
 *   POST /api/rentals/decision    {id, decision, note?} — header `x-kaya-rentals: 1`
 *
 * Mutating routes require the custom header (a cross-site form post can't set
 * it), on top of whatever remote-access token the host server enforces.
 *
 * @module RentalTracker/Board
 */
import { boardRows, loadConfig } from "./RentalTracker.ts";
import { DECISIONS, loadState, saveState, setDecision } from "./Store.ts";
import type { Decision } from "./types.ts";

export const RENTALS_API_HELP = {
  about: "Ocean Beach rental tracker — ranked listings (Craigslist + Redfin) scored against Jm's criteria. Same data as the /rentals page.",
  read: {
    "GET /api/rentals": "{rows[], runs[], criteria} — rows are de-duplicated active listings, best first. ?expired=1 adds expired ones.",
    "GET /api/rentals/help": "this document",
  },
  write: {
    note: "POST, JSON body, header `x-kaya-rentals: 1` required",
    "POST /api/rentals/decision": `{id, decision: ${DECISIONS.join("|")}, note?} → marks a listing; rejected listings never alert`,
  },
  cli: "bun skills/Life/RentalTracker/Tools/RentalTracker.ts scan|board|show|decide|status|serve",
} as const;

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function boardData(includeExpired: boolean) {
  const state = loadState();
  const cfg = loadConfig();
  return {
    rows: boardRows(state, { includeExpired }),
    runs: state.runs.slice(-10),
    criteria: cfg.criteria,
    alertMinScore: cfg.alerts.minScore,
  };
}

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#1a1d21;--muted:#6b7280;--line:#e5e7eb;--accent:#0e7490;--green:#2f9e44;--red:#e5484d;--amber:#b7791f;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
a{color:var(--accent);text-decoration:none} a:hover{text-decoration:underline}
header{position:sticky;top:0;z-index:10;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 18px 8px}
header .t{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap} header h1{margin:0;font-size:19px}
.muted{color:var(--muted)} .small{font-size:12px}
.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}
.filters select,.filters input[type=search]{font:inherit;font-size:12.5px;border:1px solid var(--line);border-radius:8px;padding:4px 7px;background:#fff}
.filters label.tg{font-size:12.5px;border:1px solid var(--line);border-radius:999px;padding:3px 10px;background:#fff;cursor:pointer;user-select:none}
.filters label.tg input{display:none} .filters label.tg.on{background:var(--ink);color:#fff;border-color:var(--ink)}
main{padding:14px 18px 60px;max-width:1300px;margin:0 auto}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(400px,1fr));align-items:start}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
.card.hot{border-color:#9be3b0;box-shadow:0 0 0 2px #e3f8e8} .card.rejected{opacity:.55}
.top{display:flex;gap:12px;padding:12px 14px 6px}
.ph{width:110px;height:82px;border-radius:8px;object-fit:cover;flex:none;background:#e8eef1;display:flex;align-items:center;justify-content:center;font-size:30px}
.score{flex:none;width:46px;height:46px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-weight:750;font-size:18px;color:#fff;background:#9ca3af}
.score.s80{background:var(--green)} .score.s65{background:var(--amber)}
.main{flex:1;min-width:0} .price{font-size:18px;font-weight:700} .addr{font-size:13px;overflow-wrap:anywhere}
.chips{display:flex;gap:5px;flex-wrap:wrap;margin:6px 0 2px;padding:0 14px}
.chip{font-size:11.5px;padding:1px 8px;border-radius:999px;border:1px solid var(--line);background:#f3f4f6;color:#374151;white-space:nowrap}
.chip.y{background:#eefcf1;color:var(--green);border-color:#b7e0c0} .chip.n{background:#fde8e8;color:var(--red);border-color:#f7c4c4}
.chip.q{background:#fff7ed;color:#9a3412;border-color:#fed7aa} .chip.b{background:#e0f2fe;color:#075985;border-color:#bae6fd}
.dist{padding:2px 14px;font-size:12.5px;color:#374151}
.sum{padding:4px 14px;font-size:13px} .hl{padding:0 14px;font-size:12px}
.foot{margin-top:auto;border-top:1px solid #f1f2f4;padding:8px 14px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.btn{border:1px solid var(--line);background:#fff;border-radius:8px;padding:3px 9px;font-size:12px;cursor:pointer;font-weight:600}
.btn.on{background:var(--ink);color:#fff;border-color:var(--ink)} .btn:hover{border-color:var(--ink)}
.note{flex:1;min-width:120px;font:inherit;font-size:12px;border:1px solid var(--line);border-radius:8px;padding:3px 7px}
details{padding:0 14px 8px;font-size:12px} summary{cursor:pointer;color:var(--muted)}
table.bd{border-collapse:collapse;margin-top:4px} table.bd td{padding:1px 8px 1px 0}
.warn{margin:0 0 10px;padding:7px 12px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;border-radius:8px;font-size:12.5px}
.empty{padding:40px;text-align:center;color:var(--muted)}
.toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--ink);color:#fff;padding:7px 14px;border-radius:10px;font-size:13px;display:none;z-index:20}
@media (max-width:520px){.grid{grid-template-columns:minmax(0,1fr)} main{padding:10px} .ph{width:84px;height:64px}}
`;

// Client-side renderer: everything below runs in the browser against window.__DATA.
const CLIENT_JS = String.raw`
const D = window.__DATA;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const walk = (mi) => Math.max(1, Math.round(mi * 1.25 * 20));
const ago = (iso) => { if (!iso) return "?"; const h = (Date.now() - Date.parse(iso)) / 36e5; return h < 1 ? "just now" : h < 24 ? Math.round(h) + "h ago" : Math.round(h / 24) + "d ago"; };
const KIND = {house:"🏡 house",duplex_cottage:"🏠 cottage/duplex",condo_townhome:"🏢 condo/townhome",apartment:"🏢 apartment",unknown:""};
const LAUNDRY = {in_unit:["W/D in unit","y"],on_site:["laundry on site","b"],none:["no laundry","n"],unknown:["laundry ?","q"]};
const DEC = [["shortlist","⭐ Shortlist"],["contacted","✉ Contacted"],["toured","🏠 Toured"],["rejected","✗ Reject"]];
const F_KEY = "kaya-rentals-filters-v1";
const defaults = {maxPrice:"3500",beds:"any",dw:false,wd:false,yard:false,ac:false,walk:"any",view:"active",sort:"score",q:""};
let F = Object.assign({}, defaults, JSON.parse(localStorage.getItem(F_KEY) || "{}"));

function chips(r){
  const f = r.features || {}, out = [];
  out.push(f.dishwasher==="yes" ? '<span class="chip y">✓ dishwasher</span>' : f.dishwasher==="no" ? '<span class="chip n">✗ dishwasher</span>' : '<span class="chip q">? dishwasher</span>');
  const [lt, lc] = LAUNDRY[f.laundry || "unknown"]; out.push('<span class="chip '+lc+'">'+lt+'</span>');
  if (f.yard==="private") out.push('<span class="chip y">🌿 private yard</span>'); else if (f.yard==="shared") out.push('<span class="chip">shared yard</span>');
  if (f.ac==="yes") out.push('<span class="chip y">❄ A/C</span>');
  if (f.kitchen==="large") out.push('<span class="chip y">🍳 big kitchen</span>'); else if (f.kitchen==="small") out.push('<span class="chip">small kitchen</span>');
  if (KIND[f.propertyKind]) out.push('<span class="chip">'+KIND[f.propertyKind]+'</span>');
  if (f.scamRisk && f.scamRisk!=="low") out.push('<span class="chip n">⚠ '+f.scamRisk+' scam risk</span>');
  if (Date.now() - Date.parse(r.firstSeenAt) < 864e5) out.push('<span class="chip b">NEW</span>');
  const ph = r.priceHistory || []; if (ph.length > 1 && ph[ph.length-1].price < ph[0].price) out.push('<span class="chip y">↓ $'+(ph[0].price-ph[ph.length-1].price)+' price drop</span>');
  if (r.alertedAt) out.push('<span class="chip b">🔔 alerted</span>');
  if (r.status==="expired") out.push('<span class="chip n">expired — '+esc(r.expiredReason)+'</span>');
  if (f.extractor==="keywords") out.push('<span class="chip q" title="LLM extraction failed; keyword guess">keyword-read</span>');
  if (r.score && !r.score.eligible) out.push('<span class="chip n">'+esc(r.score.ineligibleReasons.join(", "))+'</span>');
  return out.join("");
}

function card(r){
  const s = r.score, f = r.features || {};
  const cls = s.total >= D.alertMinScore ? "s80" : s.total >= 65 ? "s65" : "";
  const beds = (r.beds ?? "?") + (r.bedsMax && r.bedsMax !== r.beds ? "-" + r.bedsMax : "") + "BR" + (r.baths ? " / " + r.baths + "BA" : "") + (r.sqft ? " · " + r.sqft + " ft²" : "");
  const photo = r.photo ? '<img class="ph" loading="lazy" src="'+esc(r.photo)+'" alt="">' : '<div class="ph">'+(f.propertyKind==="house"||f.propertyKind==="duplex_cottage"?"🏡":"🏢")+'</div>';
  const near = s.newportMi <= s.voltaireMi;
  const parts = Object.entries(s.parts).map(([k,v]) => '<tr><td>'+k+'</td><td>'+(v>0?"+":"")+v+'</td></tr>').join("");
  // Duplicates: one link per source, with a repost count (craigslist spammers re-post the same unit 10+ times).
  const bySrc = {}; for (const d of r.dupes) (bySrc[d.source] = bySrc[d.source] || []).push(d);
  const dupes = r.dupes.length ? ' · also on ' + Object.entries(bySrc).map(([src, ds]) => '<a target="_blank" rel="noopener" href="'+esc(ds[0].url)+'">'+src+(src === r.source ? ' (×'+ds.length+' reposts)' : (ds.length > 1 ? ' ×'+ds.length : '') + ' $'+ds[0].price)+'</a>').join(", ") : "";
  const hl = [...(f.highlights||[]).map(h=>"＋ "+esc(h)), ...(f.concerns||[]).map(c=>'<span style="color:var(--red)">－ '+esc(c)+'</span>')].join(" &nbsp; ");
  return '<div class="card '+(s.total>=D.alertMinScore&&s.eligible?"hot ":"")+(r.decision==="rejected"?"rejected":"")+'" data-id="'+esc(r.id)+'">'
    + '<div class="top">'+photo+'<div class="main"><div class="price">$'+r.price.toLocaleString()+' <span class="small muted">'+beds+'</span></div>'
    + '<div class="addr"><a target="_blank" rel="noopener" href="'+esc(r.url)+'">'+esc(r.address || r.title)+'</a></div>'
    + '<div class="small muted">'+esc(r.source)+' · posted '+ago(r.postedAt)+' · seen since '+ago(r.firstSeenAt)+dupes+'</div></div>'
    + '<div class="score '+cls+'" title="fit score /100">'+s.total+'</div></div>'
    + '<div class="chips">'+chips(r)+'</div>'
    + '<div class="dist">🏖 beach '+walk(s.beachMi)+' min · '+(near?'<b>Newport '+walk(s.newportMi)+' min</b> · Voltaire '+walk(s.voltaireMi)+' min':'Newport '+walk(s.newportMi)+' min · <b>Voltaire '+walk(s.voltaireMi)+' min</b>')+' <span class="muted small">walk</span></div>'
    + (f.summary ? '<div class="sum">'+esc(f.summary)+'</div>' : '<div class="sum muted">'+esc(r.title)+'</div>')
    + (hl ? '<div class="hl">'+hl+'</div>' : '')
    + '<details><summary>score breakdown · details</summary><table class="bd">'+parts+'</table><div class="muted" style="margin-top:4px">'+esc(r.title)+'</div><div class="muted">'+esc(r.id)+'</div></details>'
    + '<div class="foot">'+DEC.map(([d,l]) => '<button class="btn'+(r.decision===d?" on":"")+'" data-dec="'+d+'">'+l+'</button>').join("")
    + '<input class="note" placeholder="note…" value="'+esc(r.note||"")+'"></div></div>';
}

function visible(){
  const q = F.q.trim().toLowerCase();
  let rows = D.rows.filter(r => {
    const s = r.score, f = r.features || {};
    if (F.view === "expired") { if (r.status !== "expired") return false; }
    else { if (r.status === "expired") return false;
      if (F.view === "active" && (r.decision === "rejected" || !s.eligible)) return false;
      if (["shortlist","contacted","toured","rejected"].includes(F.view) && r.decision !== F.view) return false; }
    if (r.price > Number(F.maxPrice)) return false;
    if (F.beds !== "any" && r.beds !== Number(F.beds) && r.bedsMax !== Number(F.beds)) return false;
    if (F.dw && f.dishwasher !== "yes") return false;
    if (F.wd && f.laundry !== "in_unit") return false;
    if (F.yard && f.yard !== "private") return false;
    if (F.ac && f.ac !== "yes") return false;
    if (F.walk !== "any" && walk(s.walkMi) > Number(F.walk)) return false;
    if (q && !(r.title + " " + (r.address||"") + " " + (f.summary||"") + " " + (r.note||"")).toLowerCase().includes(q)) return false;
    return true;
  });
  const by = {score:(a,b)=>b.score.total-a.score.total, price:(a,b)=>a.price-b.price, newest:(a,b)=>(b.firstSeenAt).localeCompare(a.firstSeenAt), beach:(a,b)=>a.score.beachMi-b.score.beachMi}[F.sort];
  return rows.sort(by);
}

function render(){
  localStorage.setItem(F_KEY, JSON.stringify(F));
  for (const el of document.querySelectorAll("[data-f]")) {
    const k = el.dataset.f;
    if (el.type === "checkbox") { el.checked = !!F[k]; el.parentElement.classList.toggle("on", !!F[k]); } else el.value = F[k];
  }
  const rows = visible();
  $("#count").textContent = rows.length + " shown";
  $("#grid").innerHTML = rows.length ? rows.map(card).join("") : '<div class="empty">Nothing matches these filters.</div>';
}

function toast(m){ const t = $("#toast"); t.textContent = m; t.style.display = "block"; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = "none", 2200); }

async function decide(id, decision, note){
  const res = await fetch("/api/rentals/decision", {method:"POST", headers:{"content-type":"application/json","x-kaya-rentals":"1"}, body: JSON.stringify({id, decision, note})});
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) { toast("Save failed: " + (j.error || res.status)); return false; }
  const r = D.rows.find(x => x.id === id); if (r) { r.decision = j.listing.decision; r.note = j.listing.note; }
  return true;
}

document.addEventListener("input", (e) => { const k = e.target.dataset && e.target.dataset.f; if (!k) return; F[k] = e.target.type === "checkbox" ? e.target.checked : e.target.value; render(); });
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-dec]"); if (!b) return;
  const id = b.closest(".card").dataset.id, r = D.rows.find(x => x.id === id);
  const next = r.decision === b.dataset.dec ? "new" : b.dataset.dec;
  if (await decide(id, next)) { toast(next === "new" ? "Cleared" : "Marked " + next); render(); }
});
document.addEventListener("change", async (e) => {
  if (!e.target.classList.contains("note")) return;
  const id = e.target.closest(".card").dataset.id, r = D.rows.find(x => x.id === id);
  if (await decide(id, r.decision, e.target.value)) toast("Note saved");
});
$("#reset").onclick = () => { F = Object.assign({}, defaults); render(); };
render();
`;

function renderPage(data: ReturnType<typeof boardData>): string {
  const last = data.runs[data.runs.length - 1];
  const activeRows = data.rows.filter((r) => r.status === "active");
  const warns: string[] = [];
  if (!last) warns.push("No scan has run yet — run <code>bun skills/Life/RentalTracker/Tools/RentalTracker.ts scan</code>.");
  else {
    for (const [src, s] of Object.entries(last.sources)) if (!s.ok) warns.push(`Last scan: <b>${esc(src)}</b> failed — ${esc(s.error)}. Its listings were kept as-is (nothing expired).`);
    if (Date.now() - Date.parse(last.at) > 8 * 3600_000) warns.push(`Last scan was ${esc(new Date(last.at).toLocaleString())} — the scheduled job may not be running.`);
    if (last.extractionFallbacks) warns.push(`${last.extractionFallbacks} listing(s) were read by keyword fallback (LLM extraction failed) — marked "keyword-read".`);
  }
  const lastTxt = last ? new Date(last.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never";
  const sel = (f: string, opts: [string, string][]) => `<select data-f="${f}">${opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>`;
  const tg = (f: string, l: string) => `<label class="tg"><input type="checkbox" data-f="${f}">${l}</label>`;
  // </script> can't appear inside the inline JSON — escape the slash.
  const json = JSON.stringify(data).replace(/<\//g, "<\\/");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OB Rentals</title><style>${CSS}</style></head><body>
<header><div class="t"><h1>🏖️ Ocean Beach rentals</h1>
<span class="muted small">${activeRows.length} active · ${activeRows.filter((r) => r.score?.eligible).length} meet the must-haves · last scan ${esc(lastTxt)} · alert at ≥ ${data.alertMinScore}</span>
<span class="small"><a href="/">← dashboard</a> · <a href="/api/rentals/help">API</a></span></div>
<div class="filters">
${sel("view", [["active", "Active (must-haves)"], ["all", "All active"], ["shortlist", "⭐ Shortlist"], ["contacted", "✉ Contacted"], ["toured", "🏠 Toured"], ["rejected", "✗ Rejected"], ["expired", "Expired"]])}
${sel("sort", [["score", "Sort: best fit"], ["price", "Sort: price"], ["newest", "Sort: newest"], ["beach", "Sort: closest to beach"]])}
${sel("maxPrice", [["3500", "≤ $3,500"], ["3250", "≤ $3,250"], ["3000", "≤ $3,000"], ["2750", "≤ $2,750"], ["2500", "≤ $2,500"]])}
${sel("beds", [["any", "1–2 BR"], ["1", "1 BR"], ["2", "2 BR"]])}
${sel("walk", [["any", "Any walk"], ["5", "≤ 5 min to Newport/Voltaire"], ["10", "≤ 10 min"], ["15", "≤ 15 min"]])}
${tg("dw", "✓ dishwasher")}${tg("wd", "W/D in unit")}${tg("yard", "🌿 yard")}${tg("ac", "❄ A/C")}
<input type="search" data-f="q" placeholder="search…"> <button class="btn" id="reset">reset</button> <span id="count" class="muted small"></span>
</div></header>
<main>${warns.map((w) => `<div class="warn">${w}</div>`).join("")}<div class="grid" id="grid"></div></main>
<div class="toast" id="toast"></div>
<script>window.__DATA=${json};</script><script>${CLIENT_JS}</script>
</body></html>`;
}

async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Returns a Response for /rentals and /api/rentals*, or null for any other path. */
export async function handleRentalsRoute(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path !== "/rentals" && path !== "/api/rentals" && !path.startsWith("/api/rentals/")) return null;

  if (req.method === "GET" && path === "/rentals") {
    return new Response(renderPage(boardData(true)), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  if (req.method === "GET" && path === "/api/rentals/help") return Response.json(RENTALS_API_HELP);
  if (req.method === "GET" && path === "/api/rentals") return Response.json(boardData(url.searchParams.get("expired") === "1"));

  if (req.method !== "POST") return Response.json({ ok: false, error: "method not allowed" }, { status: 405 });
  if (req.headers.get("x-kaya-rentals") !== "1") return Response.json({ ok: false, error: "missing header x-kaya-rentals: 1" }, { status: 403 });

  if (path === "/api/rentals/decision") {
    const body = await jsonBody(req);
    try {
      const state = loadState();
      const l = setDecision(state, String(body.id ?? ""), String(body.decision ?? "") as Decision, typeof body.note === "string" ? body.note : undefined);
      saveState(state);
      return Response.json({ ok: true, listing: { id: l.id, decision: l.decision, note: l.note } });
    } catch (err) {
      return Response.json({ ok: false, error: (err as Error).message }, { status: 400 });
    }
  }
  return Response.json({ ok: false, error: "unknown route — GET /api/rentals/help" }, { status: 404 });
}

/** Standalone server (loopback only) for when the LifeOS dashboard isn't running. */
export function serveBoard(port: number): void {
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/") return Response.redirect("/rentals", 302);
      return (await handleRentalsRoute(req, url)) ?? new Response("not found", { status: 404 });
    },
  });
  console.log(`[rentals] board on http://127.0.0.1:${port}/rentals`);
}
