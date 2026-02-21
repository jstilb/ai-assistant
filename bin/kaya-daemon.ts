#!/usr/bin/env bun
/**
 * ============================================================================
 * Kaya Daemon - Unified Long-Running Gateway Process
 * ============================================================================
 *
 * PURPOSE:
 * Single long-running daemon that integrates all Kaya background services:
 * - CronManager: Schedule and execute cron jobs
 * - MessageQueue: Outbound notification queue with multi-channel delivery
 * - MessageRouter: Smart routing between jobs and notification channels
 * - EventBus: Typed pub/sub for intra-daemon communication
 * - JobExecutor: Isolated agent spawning for autonomous jobs
 * - HealthMonitor: Health tracking and degradation detection
 * - WebSocketServer: Control plane API for remote management
 *
 * USAGE:
 *   bun bin/kaya-daemon.ts start [--port 18000]
 *   bun bin/kaya-daemon.ts stop
 *   bun bin/kaya-daemon.ts status
 *   bun bin/kaya-daemon.ts health
 *   bun bin/kaya-daemon.ts restart
 *
 * ENDPOINTS:
 *   GET  /health              - Health check (JSON)
 *   GET  /status              - Full daemon status
 *   GET  /cron/list           - List all cron jobs
 *   POST /cron/run            - Trigger a job { jobId: string }
 *   GET  /queue/status        - Message queue stats
 *   WS   /ws                  - WebSocket control plane
 *
 * STATE:
 *   ~/.claude/MEMORY/daemon/daemon-state.json
 *   ~/.claude/MEMORY/daemon/daemon.jsonl
 *   ~/.claude/MEMORY/daemon/daemon.pid
 *
 * ============================================================================
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, statSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Subsystem imports
import { createCronManager } from '../lib/cron/CronManager';
import { createMessageQueue } from '../lib/messaging/MessageQueue';
import { createMessageRouter } from '../lib/messaging/MessageRouter';
import { createEventBus } from '../lib/messaging/EventBus';
import { createJobExecutor } from '../lib/daemon/JobExecutor';
import { createHealthMonitor } from '../lib/daemon/HealthMonitor';
import { createWebSocketServer, setDaemonContext, shutdown as wsShutdown } from '../lib/daemon/WebSocketServer';
import type { DaemonContext } from '../lib/daemon/types';

// ============================================================================
// Constants & Configuration
// ============================================================================

const KAYA_DIR = process.env.KAYA_DIR || join(homedir(), '.claude');
const DAEMON_DIR = join(KAYA_DIR, 'MEMORY', 'daemon');
const STATE_FILE = join(DAEMON_DIR, 'daemon-state.json');
const LOG_FILE = join(DAEMON_DIR, 'daemon.jsonl');
const PID_FILE = join(DAEMON_DIR, 'daemon.pid');
const LOG_MAX_SIZE = 10 * 1024 * 1024; // 10MB
const LOG_KEEP_ROTATED = 3;
const QUEUE_PROCESS_INTERVAL = 30000; // 30 seconds

interface DaemonConfig {
  port: number;
  host: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

const DEFAULT_CONFIG: DaemonConfig = {
  port: 18000,
  host: 'localhost',
  logLevel: 'info',
};

// ============================================================================
// Utilities
// ============================================================================

function ensureDaemonDir(): void {
  if (!existsSync(DAEMON_DIR)) {
    mkdirSync(DAEMON_DIR, { recursive: true });
  }
}

function loadSettings(): Record<string, any> {
  try {
    const settingsPath = join(KAYA_DIR, 'settings.json');
    if (existsSync(settingsPath)) {
      return JSON.parse(readFileSync(settingsPath, 'utf-8'));
    }
  } catch {
    // Fall through
  }
  return {};
}

function loadConfig(): DaemonConfig {
  const settings = loadSettings();
  return { ...DEFAULT_CONFIG, ...(settings.daemon || {}) };
}

const LOG_LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function logEvent(level: string, message: string, data?: Record<string, any>): void {
  ensureDaemonDir();
  const entry = { timestamp: new Date().toISOString(), level, message, ...data };

  try {
    writeFileSync(LOG_FILE, JSON.stringify(entry) + '\n', { flag: 'a' });

    const config = loadConfig();
    if (LOG_LEVELS[level] >= LOG_LEVELS[config.logLevel]) {
      console.log(`[${level.toUpperCase().padEnd(5)}] ${message}`, data ? JSON.stringify(data) : '');
    }
  } catch {
    // Silent fail
  }
}

/**
 * Rotate log file when it exceeds LOG_MAX_SIZE
 */
function rotateLogIfNeeded(): void {
  try {
    if (!existsSync(LOG_FILE)) return;
    const stat = statSync(LOG_FILE);
    if (stat.size < LOG_MAX_SIZE) return;

    // Rotate: daemon.jsonl -> daemon.jsonl.1, .1 -> .2, etc.
    for (let i = LOG_KEEP_ROTATED; i >= 1; i--) {
      const from = i === 1 ? LOG_FILE : `${LOG_FILE}.${i - 1}`;
      const to = `${LOG_FILE}.${i}`;
      if (existsSync(from)) {
        renameSync(from, to);
      }
    }

    logEvent('info', 'Log rotated');
  } catch (err) {
    console.error('Log rotation failed:', err);
  }
}

// ============================================================================
// PID & State Management
// ============================================================================

function isDaemonRunning(): boolean {
  if (!existsSync(PID_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getDaemonPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  try {
    return parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
  } catch {
    return null;
  }
}

function savePid(pid: number): void {
  ensureDaemonDir();
  writeFileSync(PID_FILE, String(pid));
}

function removePidFile(): void {
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
}

interface DaemonState {
  pid: number;
  port: number;
  startTime: string;
  health: string;
}

function saveState(state: DaemonState): void {
  ensureDaemonDir();
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    // Silent fail
  }
}

function loadState(): DaemonState | null {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {
    // Fall through
  }
  return null;
}

// ============================================================================
// HTTP Request Handlers (backed by real subsystems)
// ============================================================================

let daemonCtx: DaemonContext | null = null;
let daemonStartTime: number;

async function handleHealth(): Promise<Response> {
  if (!daemonCtx) {
    return Response.json({ status: 'starting', timestamp: new Date().toISOString() }, { status: 503 });
  }

  const health = daemonCtx.healthMonitor.getHealth();
  return Response.json(health, { status: health.status === 'unhealthy' ? 503 : 200 });
}

async function handleStatus(): Promise<Response> {
  if (!daemonCtx) {
    return Response.json({ status: 'starting' }, { status: 503 });
  }

  const { cronManager, messageQueue, healthMonitor } = daemonCtx;
  const jobs = await cronManager.listJobs();
  const queueStatus = messageQueue.getQueueStatus();
  const health = healthMonitor.getHealth();

  return Response.json({
    pid: process.pid,
    port: loadConfig().port,
    startTime: new Date(daemonStartTime).toISOString(),
    uptime: Math.floor((Date.now() - daemonStartTime) / 1000),
    health: health.status,
    cron: {
      total: jobs.length,
      enabled: jobs.filter(j => j.enabled).length,
      jobs: jobs.map(j => ({
        id: j.id,
        type: j.type,
        schedule: j.schedule,
        enabled: j.enabled,
        nextRun: j.nextRun,
        lastRun: j.lastRun,
        runCount: j.runCount,
        failCount: j.failCount,
      })),
    },
    queue: queueStatus,
    healthDetails: health,
  });
}

async function handleCronList(): Promise<Response> {
  if (!daemonCtx) return Response.json({ jobs: [] }, { status: 503 });
  const jobs = await daemonCtx.cronManager.listJobs();
  return Response.json({
    jobs: jobs.map(j => ({
      id: j.id,
      type: j.type,
      schedule: j.schedule,
      output: j.output,
      enabled: j.enabled,
      nextRun: j.nextRun,
      lastRun: j.lastRun,
      runCount: j.runCount,
      failCount: j.failCount,
      task: j.task.slice(0, 200),
    })),
    count: jobs.length,
  });
}

async function handleCronRun(request: Request): Promise<Response> {
  if (!daemonCtx) return Response.json({ error: 'Not ready' }, { status: 503 });

  try {
    const { jobId } = (await request.json()) as { jobId: string };
    if (!jobId) return Response.json({ error: 'jobId required' }, { status: 400 });

    // Trigger async - don't wait for completion
    daemonCtx.cronManager.runJobNow(jobId).catch(err => {
      logEvent('error', `Job run failed: ${jobId}`, { error: String(err) });
    });

    return Response.json({ success: true, message: `Job ${jobId} triggered` });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 400 });
  }
}

async function handleQueueStatus(): Promise<Response> {
  if (!daemonCtx) return Response.json({ pending: 0, failed: 0, processed: 0 }, { status: 503 });
  return Response.json(daemonCtx.messageQueue.getQueueStatus());
}

function handleWebSocketUpgrade(request: Request, server: any): Response {
  const success = server.upgrade(request);
  if (success) return new Response(null, { status: 101 });
  return Response.json({ error: 'WebSocket upgrade failed' }, { status: 400 });
}

async function routeRequest(request: Request, server: any): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === '/health' && method === 'GET') return handleHealth();
  if (path === '/status' && method === 'GET') return handleStatus();
  if (path === '/cron/list' && method === 'GET') return handleCronList();
  if (path === '/cron/run' && method === 'POST') return handleCronRun(request);
  if (path === '/queue/status' && method === 'GET') return handleQueueStatus();
  if (request.headers.get('upgrade') === 'websocket') {
    return handleWebSocketUpgrade(request, server);
  }

  return Response.json({ error: 'Not found' }, { status: 404 });
}

// ============================================================================
// Daemon Lifecycle
// ============================================================================

async function startDaemon(config: DaemonConfig): Promise<void> {
  if (isDaemonRunning()) {
    console.error('Daemon is already running');
    process.exit(1);
  }

  daemonStartTime = Date.now();
  ensureDaemonDir();
  rotateLogIfNeeded();

  logEvent('info', 'Daemon starting', { port: config.port, pid: process.pid });

  // ── 1. Create EventBus (central nervous system) ──
  const eventBus = createEventBus();

  // ── 2. Create MessageQueue ──
  const messageQueue = createMessageQueue();

  // ── 3. Create MessageRouter ──
  const settings = loadSettings();
  const messageRouter = createMessageRouter({
    messageQueue,
    quietHours: settings.daemon?.quietHours,
  });

  // ── 4. Create CronManager ──
  const cronManager = createCronManager({
    jobsDir: join(KAYA_DIR, 'MEMORY/daemon/cron/jobs'),
    stateDir: join(KAYA_DIR, 'MEMORY/daemon/cron'),
    checkInterval: 60000,
  });

  // ── 5. Create JobExecutor ──
  const jobExecutor = createJobExecutor({
    messageRouter,
    eventBus,
    logDir: join(KAYA_DIR, 'MEMORY/daemon/cron/logs'),
  });

  // ── 6. Create HealthMonitor ──
  const healthMonitor = createHealthMonitor({ eventBus });

  // ── 7. Assemble DaemonContext ──
  daemonCtx = {
    cronManager,
    messageQueue,
    messageRouter,
    eventBus,
    jobExecutor,
    healthMonitor,
  };

  // ── 8. Wire subsystems ──

  // Register JobExecutor as the CronManager callback
  cronManager.onJobExecute(jobExecutor.execute);

  // Start HealthMonitor (subscribes to EventBus)
  healthMonitor.start();

  // Create WebSocket handler and inject context
  const websocket = createWebSocketServer();
  setDaemonContext(daemonCtx);

  // ── 9. Start HTTP + WebSocket server ──
  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    async fetch(request, server) {
      return routeRequest(request, server);
    },
    websocket,
  });

  healthMonitor.setCheck('webSocket', true);
  healthMonitor.setCheck('stateStorage', existsSync(DAEMON_DIR));

  // ── 10. Start CronManager ──
  await cronManager.start();
  healthMonitor.setCheck('cronManager', true);
  healthMonitor.setCheck('messageQueue', true);

  // ── 11. Start periodic queue processing ──
  const queueInterval = setInterval(async () => {
    try {
      await messageQueue.process();
      const status = messageQueue.getQueueStatus();
      if (status.pending > 0 || status.processed > 0) {
        eventBus.emit({
          type: 'queue.processed',
          count: status.processed,
          pending: status.pending,
          failed: status.failed,
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      logEvent('error', 'Queue processing error', { error: String(err) });
    }
  }, QUEUE_PROCESS_INTERVAL);

  // ── 12. Periodic log rotation ──
  const rotateInterval = setInterval(() => {
    rotateLogIfNeeded();
  }, 3600000); // Check every hour

  // ── 13. Periodic state save ──
  const stateInterval = setInterval(() => {
    if (daemonCtx) {
      const health = daemonCtx.healthMonitor.getHealth();
      saveState({
        pid: process.pid,
        port: config.port,
        startTime: new Date(daemonStartTime).toISOString(),
        health: health.status,
      });
    }
  }, 60000); // Every minute

  // ── 14. Save PID and state ──
  savePid(process.pid);
  saveState({
    pid: process.pid,
    port: config.port,
    startTime: new Date(daemonStartTime).toISOString(),
    health: 'healthy',
  });

  // ── 15. Emit startup event ──
  eventBus.emit({
    type: 'daemon.started',
    port: config.port,
    pid: process.pid,
    timestamp: Date.now(),
  });

  logEvent('info', 'Daemon started', { port: config.port, pid: process.pid });

  console.log(`\n  Kaya Daemon started`);
  console.log(`  Port:    ${config.port}`);
  console.log(`  PID:     ${process.pid}`);
  console.log(`  Health:  http://${config.host}:${config.port}/health`);
  console.log(`  WS:      ws://${config.host}:${config.port}/ws\n`);

  // ── Graceful shutdown ──
  const shutdown = async () => {
    logEvent('info', 'Shutting down daemon');
    console.log('\n  Shutting down Kaya daemon...');

    eventBus.emit({
      type: 'daemon.stopping',
      reason: 'signal',
      timestamp: Date.now(),
    });

    // Stop periodic tasks
    clearInterval(queueInterval);
    clearInterval(rotateInterval);
    clearInterval(stateInterval);

    // Kill isolated processes
    jobExecutor.killAll();

    // Stop subsystems
    cronManager.stop();
    healthMonitor.stop();
    wsShutdown();
    eventBus.clear();

    // Stop HTTP server
    server.stop();

    // Cleanup
    removePidFile();

    logEvent('info', 'Daemon stopped');
    console.log('  Daemon stopped\n');

    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

async function stopDaemon(): Promise<void> {
  const pid = getDaemonPid();

  if (!pid) {
    console.error('Daemon is not running (no PID file)');
    process.exit(1);
  }

  if (!isDaemonRunning()) {
    console.error('Daemon is not running (stale PID file)');
    removePidFile();
    process.exit(1);
  }

  console.log(`Stopping daemon (PID: ${pid})...`);
  process.kill(pid, 'SIGTERM');

  let attempts = 0;
  while (isDaemonRunning() && attempts < 10) {
    await new Promise(resolve => setTimeout(resolve, 500));
    attempts++;
  }

  if (isDaemonRunning()) {
    console.log('Forcing stop...');
    process.kill(pid, 'SIGKILL');
  }

  removePidFile();
  console.log('Daemon stopped');
}

async function checkStatus(config: DaemonConfig): Promise<void> {
  if (!isDaemonRunning()) {
    console.log('Daemon is not running');
    process.exit(1);
  }

  try {
    const res = await fetch(`http://${config.host}:${config.port}/status`);
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  } catch {
    // Fallback to state file
    const state = loadState();
    if (state) {
      console.log(`Daemon running (PID: ${state.pid}, Port: ${state.port})`);
    } else {
      console.log(`Daemon running (PID: ${getDaemonPid()})`);
    }
  }
}

async function checkHealth(config: DaemonConfig): Promise<void> {
  if (!isDaemonRunning()) {
    console.log('Daemon is not running');
    process.exit(1);
  }

  try {
    const res = await fetch(`http://${config.host}:${config.port}/health`);
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Health check failed:', err);
    process.exit(1);
  }
}

// ============================================================================
// CLI
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';
  const config = loadConfig();

  // Parse flags
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      config.port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--host' && args[i + 1]) {
      config.host = args[i + 1];
      i++;
    }
  }

  switch (command) {
    case 'start':
      await startDaemon(config);
      break;
    case 'stop':
      await stopDaemon();
      break;
    case 'status':
      await checkStatus(config);
      break;
    case 'health':
      await checkHealth(config);
      break;
    case 'restart':
      if (isDaemonRunning()) {
        await stopDaemon();
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      await startDaemon(config);
      break;
    case 'help':
    case '--help':
    case '-h':
      console.log(`
Kaya Daemon - Unified Long-Running Gateway

Usage:
  bun bin/kaya-daemon.ts <command> [options]

Commands:
  start              Start the daemon
  stop               Stop the daemon
  restart            Restart the daemon
  status             Show daemon status (queries HTTP API)
  health             Health check (queries HTTP API)

Options:
  --port <port>      Port to listen on (default: 18000)
  --host <host>      Host to bind to (default: localhost)

Endpoints:
  GET  /health       Health check
  GET  /status       Full daemon status
  GET  /cron/list    List cron jobs
  POST /cron/run     Trigger job: { "jobId": "..." }
  GET  /queue/status Message queue stats
  WS   /ws           WebSocket control plane

State:
  ~/.claude/MEMORY/daemon/daemon-state.json
  ~/.claude/MEMORY/daemon/daemon.jsonl
  ~/.claude/MEMORY/daemon/daemon.pid
      `);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
