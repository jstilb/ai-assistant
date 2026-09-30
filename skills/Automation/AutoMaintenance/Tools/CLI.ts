#!/usr/bin/env bun
/**
 * TechDebtTracker CLI
 * Verbs: add | list | top | resolve | rescore
 *
 * Usage:
 *   bun CLI.ts add "<description>" --location <loc> --category <cat>
 *   bun CLI.ts list
 *   bun CLI.ts top [N]
 *   bun CLI.ts resolve <id>
 *   bun CLI.ts rescore [N]
 */

import { TechDebtRegistry } from "./TechDebtRegistry.ts";
import { TechDebtPromoter } from "./TechDebtPromoter.ts";
// cross-skill-allowed: TechDebtTracker CLI enqueues promoted debt items into QueueRouter's QueueManager by design; seam candidate: QueueClient.enqueueItem (lib/interfaces/QueueTaskIntegration.ts) — deferred
import { QueueManager } from "../../QueueRouter/Tools/QueueManager.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printUsage();
    process.exit(1);
  }

  const verb = args[0];
  const registry = new TechDebtRegistry();

  switch (verb) {
    case "add": {
      // Parse: add <description> --location <loc> --category <cat>
      const positional: string[] = [];
      let location: string | undefined;
      let category: string | undefined;

      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--location" && args[i + 1]) {
          location = args[++i];
        } else if (args[i] === "--category" && args[i + 1]) {
          category = args[++i];
        } else {
          positional.push(args[i]!);
        }
      }

      const description = positional.join(" ").trim();

      if (!description) {
        console.error("Error: description is required for 'add'");
        process.exit(1);
      }
      if (!location) {
        console.error("Error: --location is required for 'add'");
        process.exit(1);
      }
      if (!category) {
        console.error("Error: --category is required for 'add'");
        process.exit(1);
      }

      const { item, isDuplicate } = await registry.add({ description, location, category });
      const scoreDisplay = item.score?.composite !== null && item.score?.composite !== undefined
        ? String(item.score.composite)
        : "pending";

      if (isDuplicate) {
        console.log(`Existing item ${item.id} (score: ${scoreDisplay})`);
      } else {
        console.log(`Added item ${item.id} (score: ${scoreDisplay})`);
      }
      break;
    }

    case "list": {
      const items = registry.list();
      if (items.length === 0) {
        console.log("No open tech debt items.");
        break;
      }
      for (const item of items) {
        const score = item.score?.composite !== null && item.score?.composite !== undefined
          ? item.score.composite
          : "null";
        console.log(`${item.id}  ${item.description}  ${item.location}  score:${score}`);
      }
      break;
    }

    case "top": {
      const n = args[1] ? parseInt(args[1], 10) : 10;
      if (isNaN(n) || n < 1) {
        console.error("Error: top requires a positive integer N");
        process.exit(1);
      }
      const items = registry.top(n);
      if (items.length === 0) {
        console.log("No open tech debt items.");
        break;
      }
      for (const item of items) {
        const score = item.score?.composite !== null && item.score?.composite !== undefined
          ? item.score.composite
          : "null";
        console.log(`${item.id}  ${item.description}  ${item.location}  score:${score}`);
      }
      break;
    }

    case "resolve": {
      const id = args[1];
      if (!id) {
        console.error("Error: resolve requires an item id");
        process.exit(1);
      }
      const resolved = registry.resolve(id);
      if (!resolved) {
        console.error(`Error: item '${id}' not found`);
        process.exit(1);
      }
      console.log(`Resolved item ${resolved.id} (status: fixed)`);
      break;
    }

    case "promote": {
      const id = args[1];
      if (!id) {
        console.error("Error: promote requires an item id");
        process.exit(1);
      }
      const promoter = new TechDebtPromoter(new QueueManager(), new TechDebtRegistry());
      const { promotedItemId } = await promoter.promoteItem(id);
      console.log(`Promoted item ${id} into spec-pipeline (entry: ${promotedItemId})`);
      break;
    }

    case "rescore": {
      // N bounds how many null-scored open items are ATTEMPTED this call.
      // Default 50 when omitted — a manual/interactive invocation with no
      // explicit N should not accidentally kick off hundreds of inference
      // calls; the weekly workflow always passes an explicit bound (200).
      const DEFAULT_RESCORE_LIMIT = 50;
      let limit: number;
      if (args[1] !== undefined) {
        limit = parseInt(args[1], 10);
        if (isNaN(limit) || limit < 1) {
          console.error("Error: rescore requires a positive integer N");
          process.exit(1);
        }
      } else {
        limit = DEFAULT_RESCORE_LIMIT;
      }

      const result = await registry.rescoreNulls(limit);
      console.log(
        `Rescore complete: attempted ${result.attempted}, rescored ${result.rescored}, stillNull ${result.stillNull}, remainingNull ${result.remainingNull}`
      );
      break;
    }

    default: {
      console.error(`Unknown verb: ${verb}`);
      printUsage();
      process.exit(1);
    }
  }
}

function printUsage(): void {
  console.error(`Usage:
  bun CLI.ts add "<description>" --location <loc> --category <cat>
  bun CLI.ts list
  bun CLI.ts top [N]
  bun CLI.ts resolve <id>
  bun CLI.ts promote <id>
  bun CLI.ts rescore [N]   (rescore up to N null-scored open items; default 50 if N omitted)`);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
