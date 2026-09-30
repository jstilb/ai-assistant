#!/usr/bin/env bun
/**
 * SqlUI.ts — a tiny local web workbench for events.db (or any DuckDB file).
 *
 * READ-ONLY: every request opens the DB in READ_ONLY mode and closes it again,
 * so the server NEVER holds the file lock between requests and can't block the
 * nightly AppUsageTracker pipeline (which needs READ_WRITE). It also physically
 * cannot mutate data. Bound to 127.0.0.1 only — not exposed on the network.
 *
 * Usage:
 *   bun Tools/SqlUI.ts                 # serves events.db on http://127.0.0.1:4555
 *   bun Tools/SqlUI.ts --port 5000
 *   bun Tools/SqlUI.ts --db /path/to/another.duckdb   # any DuckDB file (not SQLite)
 *
 * Then open the printed URL. Write SQL, ⌘/Ctrl+Enter to run. Click a table to
 * browse it; click "schema" for its columns.
 */
import { DuckDBInstance } from "@duckdb/node-api";
import { CONFIG } from "../Config.ts";

const argv = process.argv.slice(2);
function flag(name: string, def?: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const DB_PATH = (flag("--db") ?? CONFIG.dbPath).replace(/^~/, process.env.HOME ?? "~");
const PORT = Number(flag("--port", "4555"));
const MAX_ROWS = 2000;

/** Open READ_ONLY, run one fn, always close (releases the lock immediately). */
async function withDb<T>(fn: (all: (sql: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>[]>) => Promise<T>): Promise<T> {
  const instance = await DuckDBInstance.create(DB_PATH, { access_mode: "READ_ONLY" });
  const conn = await instance.connect();
  try {
    const all = async (sql: string, params?: Record<string, unknown>) => {
      const reader = params ? await conn.runAndReadAll(sql, params) : await conn.runAndReadAll(sql);
      return reader.getRowObjects() as Record<string, unknown>[];
    };
    return await fn(all);
  } finally {
    conn.disconnectSync();
    instance.closeSync();
  }
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER), MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/**
 * Make any DuckDB scalar JSON-safe. DuckDB's node-api returns TIMESTAMP/DATE/
 * DECIMAL columns as wrapper objects whose internals hold BigInts (so naive
 * JSON.stringify throws), and LIST/STRUCT as nested objects. Convert all of it.
 */
function toScalar(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v <= MAX_SAFE && v >= MIN_SAFE ? Number(v) : v.toString();
  if (v instanceof Date) return v.toISOString().replace("T", " ").slice(0, 19);
  if (typeof v === "object") {
    // DuckDB value wrappers (timestamp/date/decimal) implement a real toString();
    // plain objects/arrays (LIST/STRUCT) fall back to bigint-safe JSON.
    const o = v as { toString?: () => string };
    if (o.toString && o.toString !== Object.prototype.toString) return String(v);
    try { return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)); }
    catch { return String(v); }
  }
  return v; // string | number | boolean
}

function sanitize(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map(r => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) o[k] = toScalar(v);
    return o;
  });
}

const READ_HEADS = ["SELECT", "WITH", "DESCRIBE", "SHOW", "EXPLAIN", "PRAGMA", "TABLE", "FROM", "VALUES", "SUMMARIZE"];
function classifyQuery(sqlRaw: string): { ok: boolean; head: string } {
  const head = sqlRaw.trimStart().slice(0, 12).toUpperCase();
  return { ok: READ_HEADS.some(k => head.startsWith(k)), head };
}

/** Wrap SELECT/WITH in a row-cap subquery so `SELECT * FROM events` can't dump 144k rows. */
function capped(sqlRaw: string): { sql: string; wrapped: boolean } {
  const sql = sqlRaw.trim().replace(/;\s*$/, "");
  const head = sql.slice(0, 6).toUpperCase();
  if (head.startsWith("SELECT") || head.startsWith("WITH")) {
    return { sql: `SELECT * FROM (\n${sql}\n) AS _ui_sub LIMIT ${MAX_ROWS + 1}`, wrapped: true };
  }
  return { sql, wrapped: false };
}

async function handleQuery(sqlRaw: string): Promise<Response> {
  const t0 = Bun.nanoseconds();
  const { ok } = classifyQuery(sqlRaw);
  if (!ok) {
    return Response.json({ error: `Read-only: query must start with one of ${READ_HEADS.join(", ")}.` }, { status: 400 });
  }
  try {
    const { sql, wrapped } = capped(sqlRaw);
    const rows = await withDb(all => all(sql));
    const clean = sanitize(rows);
    const truncated = wrapped && clean.length > MAX_ROWS;
    const out = truncated ? clean.slice(0, MAX_ROWS) : clean;
    const columns = out.length ? Object.keys(out[0]!) : [];
    const ms = (Bun.nanoseconds() - t0) / 1e6;
    return Response.json({ columns, rows: out, rowCount: out.length, truncated, ms: Math.round(ms) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

async function handleTables(): Promise<Response> {
  try {
    const out = await withDb(async all => {
      const tabs = await all(`SELECT table_name FROM information_schema.tables WHERE table_schema='main' ORDER BY table_name`);
      const res: { table: string; rows: number | string }[] = [];
      for (const t of tabs) {
        const name = String(t.table_name);
        const c = sanitize(await all(`SELECT COUNT(*) n FROM "${name}"`));
        res.push({ table: name, rows: c[0]!.n as number });
      }
      return res;
    });
    return Response.json({ tables: out });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

const HTML = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SQL Workbench — ${DB_PATH.split("/").pop()}</title>
<style>
  :root { --bg:#0f1419; --panel:#161b22; --border:#2b313a; --fg:#d6dde6; --muted:#8b97a7; --accent:#4f9cf9; --accent2:#2d6fd6; --err:#ff6b6b; --ok:#3fb950; }
  * { box-sizing:border-box; }
  html,body { margin:0; height:100%; background:var(--bg); color:var(--fg); font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  .app { display:grid; grid-template-columns:260px 1fr; height:100vh; }
  .sidebar { border-right:1px solid var(--border); background:var(--panel); overflow-y:auto; padding:10px; }
  .sidebar h2 { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:4px 4px 8px; }
  .dbpath { font-size:10px; color:var(--muted); word-break:break-all; margin:0 4px 12px; padding-bottom:10px; border-bottom:1px solid var(--border); }
  .tbl { display:flex; justify-content:space-between; align-items:center; padding:5px 8px; border-radius:6px; cursor:pointer; }
  .tbl:hover { background:#1e2530; }
  .tbl .name { color:var(--fg); }
  .tbl .rows { color:var(--muted); font-size:11px; }
  .tbl .sch { color:var(--accent); font-size:10px; margin-left:8px; opacity:0; }
  .tbl:hover .sch { opacity:1; }
  .main { display:flex; flex-direction:column; min-width:0; }
  .editor-wrap { border-bottom:1px solid var(--border); padding:10px; background:var(--panel); }
  .toolbar { display:flex; gap:10px; align-items:center; margin-bottom:8px; }
  button { background:var(--accent2); color:#fff; border:0; padding:7px 16px; border-radius:6px; cursor:pointer; font:inherit; font-weight:600; }
  button:hover { background:var(--accent); }
  .hint { color:var(--muted); font-size:11px; }
  .ro { color:var(--ok); font-size:11px; border:1px solid var(--ok); border-radius:4px; padding:1px 6px; }
  textarea { width:100%; height:130px; resize:vertical; background:var(--bg); color:var(--fg); border:1px solid var(--border); border-radius:6px; padding:10px; font:inherit; tab-size:2; }
  textarea:focus { outline:1px solid var(--accent); }
  .results { flex:1; overflow:auto; padding:0; }
  .status { padding:8px 12px; font-size:12px; color:var(--muted); border-bottom:1px solid var(--border); position:sticky; top:0; background:var(--bg); }
  .status.err { color:var(--err); white-space:pre-wrap; }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  th,td { border:1px solid var(--border); padding:5px 9px; text-align:left; white-space:nowrap; max-width:480px; overflow:hidden; text-overflow:ellipsis; }
  th { background:var(--panel); position:sticky; top:33px; color:var(--muted); font-weight:600; }
  tbody tr:hover { background:#1a2230; }
  td.num { text-align:right; color:#9fd0ff; }
  .empty { padding:24px; color:var(--muted); }
</style></head>
<body>
<div class="app">
  <aside class="sidebar">
    <h2>Tables</h2>
    <div class="dbpath" id="dbpath">${DB_PATH}</div>
    <div id="tables"></div>
  </aside>
  <main class="main">
    <div class="editor-wrap">
      <div class="toolbar">
        <button id="run">Run ▸</button>
        <span class="hint">⌘/Ctrl+Enter</span>
        <span class="ro">READ-ONLY</span>
        <span class="hint" id="meta"></span>
      </div>
      <textarea id="sql" spellcheck="false" placeholder="SELECT * FROM daily_metrics ORDER BY date DESC LIMIT 50"></textarea>
    </div>
    <div class="results">
      <div class="status" id="status">Ready. Pick a table on the left, or write SQL and hit Run.</div>
      <div id="grid"></div>
    </div>
  </main>
</div>
<script>
const $ = s => document.querySelector(s);
const sqlEl = $('#sql'), gridEl = $('#grid'), statusEl = $('#status'), metaEl = $('#meta');

async function loadTables() {
  const r = await fetch('/api/tables'); const j = await r.json();
  const box = $('#tables'); box.innerHTML = '';
  if (j.error) { box.innerHTML = '<div class="empty">'+esc(j.error)+'</div>'; return; }
  for (const t of j.tables) {
    const row = document.createElement('div'); row.className = 'tbl';
    row.innerHTML = '<span class="name">'+esc(t.table)+'</span><span><span class="rows">'+t.rows+'</span><span class="sch">schema</span></span>';
    row.querySelector('.name').onclick = () => { setSql('SELECT * FROM "'+t.table+'" LIMIT 100'); run(); };
    row.querySelector('.rows').onclick = () => { setSql('SELECT * FROM "'+t.table+'" LIMIT 100'); run(); };
    row.querySelector('.sch').onclick = (e) => { e.stopPropagation(); setSql('DESCRIBE "'+t.table+'"'); run(); };
    box.appendChild(row);
  }
}
function setSql(s){ sqlEl.value = s; }
function esc(s){ return String(s==null?'':s).replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

async function run() {
  const sql = sqlEl.value.trim(); if (!sql) return;
  statusEl.className='status'; statusEl.textContent='Running…'; gridEl.innerHTML='';
  try {
    const r = await fetch('/api/query', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({sql})});
    const j = await r.json();
    if (j.error) { statusEl.className='status err'; statusEl.textContent='✗ '+j.error; metaEl.textContent=''; return; }
    metaEl.textContent = j.ms+' ms';
    statusEl.className='status';
    statusEl.textContent = j.rowCount+' row'+(j.rowCount===1?'':'s')+(j.truncated?(' (capped at '+j.rowCount+')'):'')+' · '+j.ms+' ms';
    renderGrid(j.columns, j.rows);
  } catch(e){ statusEl.className='status err'; statusEl.textContent='✗ '+e.message; }
}

function renderGrid(cols, rows) {
  if (!rows.length) { gridEl.innerHTML = '<div class="empty">(no rows)</div>'; return; }
  let h = '<table><thead><tr>' + cols.map(c=>'<th>'+esc(c)+'</th>').join('') + '</tr></thead><tbody>';
  for (const row of rows) {
    h += '<tr>' + cols.map(c => { const v=row[c]; const num = typeof v==='number'; return '<td'+(num?' class="num"':'')+' title="'+esc(v)+'">'+esc(v)+'</td>'; }).join('') + '</tr>';
  }
  gridEl.innerHTML = h + '</tbody></table>';
}

sqlEl.addEventListener('keydown', e => { if ((e.metaKey||e.ctrlKey) && e.key==='Enter'){ e.preventDefault(); run(); }});
$('#run').onclick = run;
loadTables();
</script>
</body></html>`;

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (url.pathname === "/api/tables") return handleTables();
    if (url.pathname === "/api/query" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { sql?: string };
      if (!body.sql) return Response.json({ error: "missing sql" }, { status: 400 });
      return handleQuery(body.sql);
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`\n  SQL Workbench (READ-ONLY)  →  http://127.0.0.1:${server.port}`);
console.log(`  DB: ${DB_PATH}`);
console.log(`  Ctrl+C to stop.\n`);
