#!/usr/bin/env bun
/**
 * MealPlanner.ts - Weekly meal plan generation
 *
 * Generates meal plans based on preferences, season, and pantry.
 * Integrates with CalendarAssistant for time blocking and
 * aggregates ingredients for consolidated grocery lists.
 * Uses CORE StateManager for type-safe state persistence.
 *
 * Usage:
 *   bun Tools/MealPlanner.ts generate --days 7 --meals dinner
 *   bun Tools/MealPlanner.ts grocery-list
 *   bun Tools/MealPlanner.ts current
 *
 * @module MealPlanner
 */

import { z } from "zod";
import { createStateManager } from "../../CORE/Tools/StateManager";
import { notifySync } from "../../CORE/Tools/NotificationService";

const KAYA_HOME = process.env.HOME + "/.claude";

const MealSchema = z.object({
  day: z.string(),
  mealType: z.enum(["breakfast", "lunch", "dinner", "snack"]),
  recipeName: z.string(),
  prepTime: z.number().optional(),
  cookTime: z.number().optional(),
  servings: z.number().default(2),
  ingredients: z.array(z.object({
    item: z.string(),
    amount: z.string().optional(),
    unit: z.string().optional(),
  })),
  notes: z.string().optional(),
});

const MealPlanSchema = z.object({
  meals: z.array(MealSchema),
  createdAt: z.string(),
  weekOf: z.string(),
  lastUpdated: z.string(),
  preferences: z.object({
    meals: z.array(z.string()).default(["dinner"]),
    days: z.number().default(7),
    servings: z.number().default(2),
    maxPrepMinutes: z.number().optional(),
    cuisinePreferences: z.array(z.string()).default([]),
    dietaryRestrictions: z.array(z.string()).default([]),
  }).optional(),
});

type Meal = z.infer<typeof MealSchema>;
type MealPlan = z.infer<typeof MealPlanSchema>;

// StateManager instance for meal plan state
const planManager = createStateManager<MealPlan>({
  path: `${KAYA_HOME}/skills/Cooking/data/current-meal-plan.json`,
  schema: MealPlanSchema,
  defaults: {
    meals: [],
    createdAt: new Date().toISOString(),
    weekOf: new Date().toISOString().split("T")[0],
    lastUpdated: new Date().toISOString(),
  },
});

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export async function generatePlan(opts: {
  days?: number;
  meals?: string[];
  servings?: number;
  maxPrepMinutes?: number;
}): Promise<MealPlan> {
  const days = opts.days ?? 7;
  const meals = opts.meals ?? ["dinner"];
  const servings = opts.servings ?? 2;

  // Use inference to generate meal plan
  const prompt = `Generate a ${days}-day meal plan for ${servings} people. Meal types: ${meals.join(", ")}. ${opts.maxPrepMinutes ? `Max prep time: ${opts.maxPrepMinutes} minutes.` : ""} Return as JSON: { meals: [{ day: "Monday", mealType: "dinner", recipeName: "...", prepTime: N, cookTime: N, servings: ${servings}, ingredients: [{ item: "...", amount: "...", unit: "..." }], notes: "..." }] }. Use varied cuisines and seasonal February produce (your region). Include realistic ingredient amounts.`;

  const result = await Bun.spawn(
    ["bun", `${KAYA_HOME}/tools/Inference.ts`, "fast"],
    { stdin: new Response(prompt).body!, stdout: "pipe", stderr: "pipe" }
  );
  const output = await new Response(result.stdout).text();

  try {
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in response");
    const parsed = JSON.parse(jsonMatch[0]);
    const plan: MealPlan = {
      meals: (parsed.meals || []).map((m: Meal) => MealSchema.parse(m)),
      createdAt: new Date().toISOString(),
      weekOf: new Date().toISOString().split("T")[0],
      lastUpdated: new Date().toISOString(),
      preferences: { meals, days, servings, maxPrepMinutes: opts.maxPrepMinutes },
    };
    await planManager.save(plan);
    return plan;
  } catch {
    // Fallback: create a simple plan structure
    const plan: MealPlan = {
      meals: DAY_NAMES.slice(0, days).flatMap(day =>
        meals.map(mealType => ({
          day,
          mealType: mealType as Meal["mealType"],
          recipeName: `TBD - ${mealType} for ${day}`,
          servings,
          ingredients: [],
          notes: "Plan generation failed -- fill in manually",
        }))
      ),
      createdAt: new Date().toISOString(),
      weekOf: new Date().toISOString().split("T")[0],
      lastUpdated: new Date().toISOString(),
      preferences: { meals, days, servings },
    };
    await planManager.save(plan);
    return plan;
  }
}

export async function getGroceryList(plan?: MealPlan): Promise<Map<string, { amount: string; recipes: string[] }>> {
  const current = plan ?? (await planManager.load());
  if (!current || current.meals.length === 0) return new Map();

  const groceryMap = new Map<string, { amount: string; recipes: string[] }>();

  for (const meal of current.meals) {
    for (const ing of meal.ingredients) {
      const key = ing.item.toLowerCase().trim();
      const existing = groceryMap.get(key);
      if (existing) {
        existing.recipes.push(meal.recipeName);
      } else {
        groceryMap.set(key, {
          amount: ing.amount ? `${ing.amount}${ing.unit ? " " + ing.unit : ""}` : "as needed",
          recipes: [meal.recipeName],
        });
      }
    }
  }

  return groceryMap;
}

export async function getCurrentPlan(): Promise<MealPlan | null> {
  const plan = await planManager.load();
  if (plan.meals.length === 0) return null;
  return plan;
}

// CLI entrypoint
if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "generate": {
      const days = args.includes("--days") ? parseInt(args[args.indexOf("--days") + 1]) : 7;
      const mealsArg = args.includes("--meals") ? args[args.indexOf("--meals") + 1] : "dinner";
      const meals = mealsArg.split(",");
      const maxPrep = args.includes("--max-prep") ? parseInt(args[args.indexOf("--max-prep") + 1]) : undefined;

      console.log(`Generating ${days}-day meal plan...`);
      const plan = await generatePlan({ days, meals, maxPrepMinutes: maxPrep });
      console.log(`Plan generated with ${plan.meals.length} meals.\n`);
      plan.meals.forEach(m => {
        console.log(`  ${m.day} ${m.mealType}: ${m.recipeName}${m.prepTime ? ` (${m.prepTime}min prep)` : ""}`);
      });
      notifySync(`Meal plan created with ${plan.meals.length} meals`);
      break;
    }
    case "grocery-list": {
      const list = await getGroceryList();
      if (list.size === 0) { console.log("No meal plan found. Run 'generate' first."); break; }
      console.log(`\nGrocery List (${list.size} items):\n`);
      for (const [item, info] of list) {
        console.log(`  - ${item} -- ${info.amount} (for: ${info.recipes.join(", ")})`);
      }
      notifySync(`Grocery list ready with ${list.size} items`);
      break;
    }
    case "current": {
      const plan = await getCurrentPlan();
      if (!plan) { console.log("No meal plan found. Run 'generate' first."); break; }
      console.log(`\nCurrent Meal Plan (week of ${plan.weekOf}):\n`);
      plan.meals.forEach(m => {
        console.log(`  ${m.day} ${m.mealType}: ${m.recipeName}`);
      });
      break;
    }
    default:
      console.log("Commands: generate, grocery-list, current");
  }
}
