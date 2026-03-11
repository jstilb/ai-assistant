#!/usr/bin/env bun
import { loadQueueItems } from "./QueueManager.ts";
import { notifySync } from "../../../../lib/core/NotificationService.ts";

const items = loadQueueItems("approvals");
const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
const stale = items.filter(i =>
  (i.status === "pending" || i.status === "awaiting_approval") &&
  new Date(i.created) < cutoff
);
if (stale.length > 0) {
  notifySync(`${stale.length} approval(s) waiting >48h`, { channel: "telegram" });
}
