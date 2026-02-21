#!/usr/bin/env bun
/**
 * SeasonalProduce.ts - Regional seasonal produce data
 *
 * USDA-sourced seasonal availability for your region region.
 * Returns peak, coming-in, and going-out produce by month.
 *
 * Usage:
 *   bun Tools/SeasonalProduce.ts --month february --region san-diego
 *   bun Tools/SeasonalProduce.ts --current
 *
 * @module SeasonalProduce
 */

import { notifySync } from "../../CORE/Tools/NotificationService";

interface ProduceItem {
  name: string;
  category: "fruit" | "vegetable" | "herb";
  peakMonths: number[];
  availability: "peak" | "available" | "coming-in" | "going-out" | "off-season";
  priceNote?: string;
}

// your region region seasonal data (Southern California / USDA Zone 10)
const PRODUCE_DATABASE: Omit<ProduceItem, "availability">[] = [
  { name: "Avocado", category: "fruit", peakMonths: [3, 4, 5, 6, 7, 8] },
  { name: "Strawberry", category: "fruit", peakMonths: [1, 2, 3, 4, 5] },
  { name: "Lemon", category: "fruit", peakMonths: [12, 1, 2, 3, 4] },
  { name: "Orange", category: "fruit", peakMonths: [12, 1, 2, 3] },
  { name: "Grapefruit", category: "fruit", peakMonths: [1, 2, 3, 4] },
  { name: "Tangerine", category: "fruit", peakMonths: [11, 12, 1, 2] },
  { name: "Fig", category: "fruit", peakMonths: [6, 7, 8, 9] },
  { name: "Persimmon", category: "fruit", peakMonths: [10, 11, 12] },
  { name: "Pomegranate", category: "fruit", peakMonths: [9, 10, 11] },
  { name: "Guava", category: "fruit", peakMonths: [11, 12, 1, 2] },
  { name: "Passion Fruit", category: "fruit", peakMonths: [1, 2, 3, 8, 9, 10] },
  { name: "Tomato", category: "vegetable", peakMonths: [5, 6, 7, 8, 9, 10] },
  { name: "Zucchini", category: "vegetable", peakMonths: [5, 6, 7, 8] },
  { name: "Broccoli", category: "vegetable", peakMonths: [10, 11, 12, 1, 2, 3] },
  { name: "Cauliflower", category: "vegetable", peakMonths: [10, 11, 12, 1, 2, 3] },
  { name: "Kale", category: "vegetable", peakMonths: [10, 11, 12, 1, 2, 3] },
  { name: "Swiss Chard", category: "vegetable", peakMonths: [3, 4, 5, 6, 10, 11] },
  { name: "Arugula", category: "vegetable", peakMonths: [10, 11, 12, 1, 2, 3] },
  { name: "Beet", category: "vegetable", peakMonths: [10, 11, 12, 1, 2, 3] },
  { name: "Carrot", category: "vegetable", peakMonths: [10, 11, 12, 1, 2, 3, 4] },
  { name: "Radish", category: "vegetable", peakMonths: [10, 11, 12, 1, 2, 3] },
  { name: "Snap Pea", category: "vegetable", peakMonths: [2, 3, 4, 5] },
  { name: "Artichoke", category: "vegetable", peakMonths: [3, 4, 5] },
  { name: "Asparagus", category: "vegetable", peakMonths: [2, 3, 4, 5] },
  { name: "Corn", category: "vegetable", peakMonths: [6, 7, 8, 9] },
  { name: "Pepper", category: "vegetable", peakMonths: [6, 7, 8, 9, 10] },
  { name: "Eggplant", category: "vegetable", peakMonths: [7, 8, 9, 10] },
  { name: "Cilantro", category: "herb", peakMonths: [10, 11, 12, 1, 2, 3] },
  { name: "Basil", category: "herb", peakMonths: [5, 6, 7, 8, 9] },
  { name: "Mint", category: "herb", peakMonths: [4, 5, 6, 7, 8, 9] },
  { name: "Rosemary", category: "herb", peakMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
];

function getAvailability(peakMonths: number[], currentMonth: number): ProduceItem["availability"] {
  if (peakMonths.includes(currentMonth)) return "peak";
  const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1;
  const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
  if (peakMonths.includes(nextMonth)) return "coming-in";
  if (peakMonths.includes(prevMonth)) return "going-out";
  return "off-season";
}

export function getSeasonalProduce(month: number): ProduceItem[] {
  return PRODUCE_DATABASE
    .map(item => ({
      ...item,
      availability: getAvailability(item.peakMonths, month),
      priceNote: getAvailability(item.peakMonths, month) === "peak"
        ? "Best prices — in season"
        : getAvailability(item.peakMonths, month) === "going-out"
        ? "Prices rising — season ending"
        : undefined,
    }))
    .sort((a, b) => {
      const order = { peak: 0, "coming-in": 1, "going-out": 2, available: 3, "off-season": 4 };
      return order[a.availability] - order[b.availability];
    });
}

export function getByCategory(month: number, category: ProduceItem["category"]): ProduceItem[] {
  return getSeasonalProduce(month).filter(p => p.category === category);
}

export function getPeakOnly(month: number): ProduceItem[] {
  return getSeasonalProduce(month).filter(p => p.availability === "peak");
}

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"];

function parseMonth(input: string): number {
  const lower = input.toLowerCase();
  const idx = MONTH_NAMES.indexOf(lower);
  if (idx >= 0) return idx + 1;
  const num = parseInt(input);
  if (num >= 1 && num <= 12) return num;
  return new Date().getMonth() + 1;
}

// CLI entrypoint
if (import.meta.main) {
  const args = process.argv.slice(2);
  const monthArg = args.includes("--month") ? args[args.indexOf("--month") + 1] : undefined;
  const month = monthArg ? parseMonth(monthArg) : new Date().getMonth() + 1;
  const current = args.includes("--current");

  if (current || !monthArg) {
    console.log(`\n🌱 Seasonal Produce — ${MONTH_NAMES[month - 1].charAt(0).toUpperCase() + MONTH_NAMES[month - 1].slice(1)} (your region)\n`);
  }

  const produce = getSeasonalProduce(month);
  const peak = produce.filter(p => p.availability === "peak");
  const comingIn = produce.filter(p => p.availability === "coming-in");
  const goingOut = produce.filter(p => p.availability === "going-out");

  console.log(`🟢 Peak Season (${peak.length}):`);
  peak.forEach(p => console.log(`  ${p.category === "fruit" ? "🍎" : p.category === "herb" ? "🌿" : "🥬"} ${p.name}`));

  if (comingIn.length > 0) {
    console.log(`\n🔵 Coming Into Season (${comingIn.length}):`);
    comingIn.forEach(p => console.log(`  ${p.name}`));
  }

  if (goingOut.length > 0) {
    console.log(`\n🟡 Going Out of Season (${goingOut.length}):`);
    goingOut.forEach(p => console.log(`  ${p.name} — get it while you can!`));
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify(produce, null, 2));
  }

  notifySync(`${peak.length} items in peak season for ${MONTH_NAMES[month - 1]}`);
}
