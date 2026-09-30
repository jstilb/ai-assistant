#!/usr/bin/env bun
/**
 * PhoneAutoPoll.ts — long-running daemon that polls each known Android device
 * (phone, tablet) the moment it plugs in via USB.
 *
 * Architecture:
 *   1. Spawn `adb track-devices` (streaming; one line per state change).
 *   2. On a line matching `/^(\S+)\s+device$/`: look up serial in
 *      `CONFIG.adbDevices`. If known → set up the per-device port forward,
 *      run AWPoller --device=<name>, then run MetricCalc --force.
 *      If unknown → log the serial and skip (avoids mis-routing tablet
 *      events as phone events, which has happened before).
 *   3. On `unauthorized`/`offline`/blank line → device gone: log and wait.
 *
 * This daemon is the ONLY intraday poll path for phone/tablet — it polls on USB
 * plug-in. There is no longer a 5-min poller: the old `com.kaya.aw-poller` was
 * consolidated into the nightly `com.kaya.appusage-nightly` job (events.db lock
 * collisions). This daemon does NOT poll the mac; the mac refreshes nightly at
 * 02:00 and on-demand via `/media sync`.
 *
 * Idempotent: AWPoller uses INSERT OR REPLACE on PK; duplicate triggers are no-ops.
 * Failure-tolerant: any failure inside the handler is logged + swallowed; daemon keeps running.
 */

import { spawn, spawnSync } from "node:child_process";
import { join } from "path";
import { CONFIG, type AdbDevice } from "../Config.ts";
import { defaultKayaHome } from "../../../../lib/core/KayaHome.ts";
import { logFailure } from "./Db.ts";
import { todayLocal } from "./Util.ts";

const ADB = "/opt/homebrew/bin/adb";
const REMOTE_PORT = 5600;
const SKILL_DIR = join(defaultKayaHome(), "skills/Productivity/AppUsageTracker");

interface DeviceLine {
  serial: string;
  state: string;
}

function parseLine(line: string): DeviceLine | null {
  // `adb track-devices` uses the smart-socket protocol: each message is
  // prefixed with a 4-char hex length. Strip it before parsing.
  let trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("List of")) return null;
  if (/^[0-9a-f]{4}/i.test(trimmed)) trimmed = trimmed.slice(4).trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^(\S+)\s+(\S+)/);
  if (!m) return null;
  return { serial: m[1], state: m[2] };
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

const knownBySerial = new Map<string, AdbDevice>(
  CONFIG.adbDevices.map((d) => [d.serial, d]),
);

const lastTriggerBySerial = new Map<string, number>();
const triggerInFlightBySerial = new Set<string>();

async function onDeviceConnected(serial: string): Promise<void> {
  const dev = knownBySerial.get(serial);
  if (!dev) {
    log(`unknown serial ${serial} → ignoring (add to CONFIG.adbDevices to enable polling)`);
    return;
  }
  if (triggerInFlightBySerial.has(serial)) {
    log(`${dev.name} (${serial}) connected but its poll is already running; will skip`);
    return;
  }
  triggerInFlightBySerial.add(serial);
  try {
    log(`${dev.name} (${serial}) → forward tcp:${dev.localPort} → ${REMOTE_PORT} + poll`);

    // Establish the forward (idempotent — adb replaces existing forward on same port).
    const fwd = spawnSync(ADB, ["-s", serial, "forward", `tcp:${dev.localPort}`, `tcp:${REMOTE_PORT}`], { encoding: "utf8" });
    if (fwd.status !== 0) {
      log(`forward setup failed: ${fwd.stderr || fwd.stdout}`);
      await logFailure("PhoneAutoPoll", new Error("adb forward failed"), { serial, device: dev.name, stderr: fwd.stderr });
      return;
    }

    // Pull events for this specific device only.
    const poll = spawnSync("bun", ["run", `${SKILL_DIR}/Tools/AWPoller.ts`, `--device=${dev.name}`], { encoding: "utf8" });
    log(`AWPoller stdout: ${(poll.stdout || "").trim() || "(empty)"}`);
    if (poll.stderr) log(`AWPoller stderr: ${poll.stderr.trim()}`);

    // Recompute today's metric.
    const metric = spawnSync("bun", ["run", `${SKILL_DIR}/Tools/MetricCalc.ts`, "--force", `--date=${todayLocal()}`], { encoding: "utf8" });
    log(`MetricCalc stdout: ${(metric.stdout || "").trim().slice(0, 200) || "(empty)"}`);
    if (metric.stderr) log(`MetricCalc stderr: ${metric.stderr.trim()}`);

    log(`done with ${dev.name} (${serial})`);
  } catch (err) {
    log(`handler error: ${err instanceof Error ? err.message : String(err)}`);
    await logFailure("PhoneAutoPoll", err, { serial });
  } finally {
    triggerInFlightBySerial.delete(serial);
  }
}

function startTracker(): void {
  log("starting `adb track-devices`...");
  const proc = spawn(ADB, ["track-devices"], { stdio: ["ignore", "pipe", "pipe"] });

  let buf = "";
  proc.stdout?.on("data", async (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? ""; // hold partial line
    for (const line of lines) {
      const dev = parseLine(line);
      if (!dev) continue;
      log(`event: ${dev.serial} → ${dev.state}`);
      if (dev.state === "device") {
        // Debounce duplicate "device" lines per-serial within 5s. Each known
        // device has its own entry, so phone + tablet plug-ins don't suppress
        // each other.
        const last = lastTriggerBySerial.get(dev.serial) ?? 0;
        const now = Date.now();
        if (now - last < 5_000) {
          log(`debounced duplicate connect for ${dev.serial}`);
          continue;
        }
        lastTriggerBySerial.set(dev.serial, now);
        await onDeviceConnected(dev.serial);
      } else if (dev.state === "offline" || dev.state === "unauthorized") {
        lastTriggerBySerial.delete(dev.serial);
      }
    }
  });

  proc.stderr?.on("data", (c: Buffer) => log(`adb stderr: ${c.toString("utf8").trim()}`));

  proc.on("exit", (code) => {
    log(`adb track-devices exited code=${code}; daemon will exit so launchd can restart it`);
    process.exit(code ?? 1);
  });
}

if (import.meta.main) {
  log(`PhoneAutoPoll starting; SKILL_DIR=${SKILL_DIR}`);
  startTracker();
}
