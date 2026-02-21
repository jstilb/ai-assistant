#!/usr/bin/env bun
/**
 * SubstitutionEngine.ts - Ingredient substitution logic
 *
 * Maps ingredients by role (flavor, texture, structure, moisture, leavening)
 * and returns ranked substitutes with ratio adjustments and dietary alternatives.
 *
 * Usage:
 *   bun Tools/SubstitutionEngine.ts "buttermilk" --dietary vegan
 *   bun Tools/SubstitutionEngine.ts "eggs" --dietary egg-free --role binding
 *
 * @module SubstitutionEngine
 */

import { notifySync } from "../../CORE/Tools/NotificationService";

type IngredientRole = "flavor" | "texture" | "structure" | "moisture" | "leavening" | "fat" | "sweetener" | "acid" | "binding" | "thickener";
type DietaryTag = "vegan" | "vegetarian" | "gluten-free" | "dairy-free" | "egg-free" | "nut-free" | "soy-free" | "low-sugar";

interface Substitution {
  original: string;
  substitute: string;
  ratio: string;
  roles: IngredientRole[];
  dietaryTags: DietaryTag[];
  notes: string;
  qualityScore: number; // 1-5, how close to original
}

// Substitution database
const SUBSTITUTIONS: Record<string, Omit<Substitution, "original">[]> = {
  buttermilk: [
    { substitute: "milk + lemon juice", ratio: "1 cup milk + 1 tbsp lemon juice", roles: ["acid", "moisture"], dietaryTags: ["vegetarian"], notes: "Let sit 5 minutes before using. Closest match.", qualityScore: 5 },
    { substitute: "milk + white vinegar", ratio: "1 cup milk + 1 tbsp vinegar", roles: ["acid", "moisture"], dietaryTags: ["vegetarian"], notes: "Same technique as lemon juice method.", qualityScore: 4 },
    { substitute: "plain yogurt + milk", ratio: "3/4 cup yogurt + 1/4 cup milk", roles: ["acid", "moisture", "fat"], dietaryTags: ["vegetarian"], notes: "Thicker than buttermilk, thin with milk.", qualityScore: 4 },
    { substitute: "oat milk + lemon juice", ratio: "1 cup oat milk + 1 tbsp lemon juice", roles: ["acid", "moisture"], dietaryTags: ["vegan", "dairy-free", "soy-free"], notes: "Best vegan option. Let sit 5 minutes.", qualityScore: 3 },
  ],
  eggs: [
    { substitute: "flax egg", ratio: "1 tbsp ground flax + 3 tbsp water per egg", roles: ["binding"], dietaryTags: ["vegan", "egg-free", "dairy-free"], notes: "Mix and let sit 5 min until gel forms. Best for baking.", qualityScore: 4 },
    { substitute: "chia egg", ratio: "1 tbsp chia seeds + 3 tbsp water per egg", roles: ["binding"], dietaryTags: ["vegan", "egg-free", "dairy-free"], notes: "Similar to flax egg. Slightly visible texture.", qualityScore: 3 },
    { substitute: "mashed banana", ratio: "1/4 cup per egg", roles: ["binding", "moisture"], dietaryTags: ["vegan", "egg-free", "dairy-free", "nut-free", "soy-free"], notes: "Adds banana flavor. Best for sweet baking.", qualityScore: 3 },
    { substitute: "applesauce", ratio: "1/4 cup per egg", roles: ["binding", "moisture"], dietaryTags: ["vegan", "egg-free", "dairy-free", "nut-free", "soy-free"], notes: "Milder flavor than banana. Adds moisture.", qualityScore: 3 },
    { substitute: "aquafaba", ratio: "3 tbsp per egg", roles: ["binding", "leavening"], dietaryTags: ["vegan", "egg-free", "dairy-free", "nut-free"], notes: "Chickpea brine. Can whip like egg whites.", qualityScore: 4 },
  ],
  butter: [
    { substitute: "coconut oil", ratio: "1:1", roles: ["fat"], dietaryTags: ["vegan", "dairy-free"], notes: "Solid at room temp. Slight coconut flavor.", qualityScore: 4 },
    { substitute: "olive oil", ratio: "3/4 cup per 1 cup butter", roles: ["fat", "moisture"], dietaryTags: ["vegan", "dairy-free"], notes: "Better for savory. Don't use for delicate baking.", qualityScore: 3 },
    { substitute: "vegan butter", ratio: "1:1", roles: ["fat"], dietaryTags: ["vegan", "dairy-free"], notes: "Earth Balance or similar. Closest match.", qualityScore: 5 },
    { substitute: "avocado", ratio: "1:1", roles: ["fat", "moisture"], dietaryTags: ["vegan", "dairy-free"], notes: "For baking. Adds green tint.", qualityScore: 2 },
  ],
  "heavy cream": [
    { substitute: "coconut cream", ratio: "1:1", roles: ["fat", "moisture"], dietaryTags: ["vegan", "dairy-free"], notes: "Refrigerate can overnight, scoop solid cream.", qualityScore: 4 },
    { substitute: "cashew cream", ratio: "1:1", roles: ["fat", "moisture"], dietaryTags: ["vegan", "dairy-free"], notes: "Blend soaked cashews with water.", qualityScore: 3 },
    { substitute: "evaporated milk", ratio: "1:1", roles: ["fat", "moisture"], dietaryTags: ["vegetarian"], notes: "Lower fat but similar consistency.", qualityScore: 3 },
  ],
  "all-purpose flour": [
    { substitute: "almond flour", ratio: "1:1 (add 1 egg or binder)", roles: ["structure"], dietaryTags: ["gluten-free"], notes: "Denser result. Works well for cookies.", qualityScore: 3 },
    { substitute: "oat flour", ratio: "1:1", roles: ["structure"], dietaryTags: ["gluten-free"], notes: "Blend oats in food processor. Light texture.", qualityScore: 4 },
    { substitute: "1:1 GF flour blend", ratio: "1:1", roles: ["structure"], dietaryTags: ["gluten-free"], notes: "Bob's Red Mill or King Arthur. Best all-around sub.", qualityScore: 5 },
    { substitute: "cassava flour", ratio: "1:1", roles: ["structure"], dietaryTags: ["gluten-free", "nut-free"], notes: "Closest texture to wheat flour. Nut-free.", qualityScore: 4 },
  ],
  "sour cream": [
    { substitute: "Greek yogurt", ratio: "1:1", roles: ["acid", "fat", "moisture"], dietaryTags: ["vegetarian"], notes: "Higher protein, slightly tangier.", qualityScore: 5 },
    { substitute: "cashew cream + lemon", ratio: "1 cup cashew cream + 1 tbsp lemon", roles: ["acid", "fat", "moisture"], dietaryTags: ["vegan", "dairy-free"], notes: "Blend soaked cashews, add lemon.", qualityScore: 3 },
  ],
  sugar: [
    { substitute: "honey", ratio: "3/4 cup per 1 cup sugar", roles: ["sweetener"], dietaryTags: ["vegetarian"], notes: "Reduce other liquids by 1/4 cup. Lower oven 25°F.", qualityScore: 4 },
    { substitute: "maple syrup", ratio: "3/4 cup per 1 cup sugar", roles: ["sweetener"], dietaryTags: ["vegan"], notes: "Reduce other liquids by 3 tbsp. Adds distinct flavor.", qualityScore: 3 },
    { substitute: "coconut sugar", ratio: "1:1", roles: ["sweetener"], dietaryTags: ["vegan", "low-sugar"], notes: "Lower glycemic index. Caramel flavor.", qualityScore: 4 },
  ],
};

export function findSubstitutions(
  ingredient: string,
  dietary?: DietaryTag,
  role?: IngredientRole,
): Substitution[] {
  const key = ingredient.toLowerCase().trim();
  const subs = SUBSTITUTIONS[key];
  if (!subs) return [];

  return subs
    .filter(s => !dietary || s.dietaryTags.includes(dietary))
    .filter(s => !role || s.roles.includes(role))
    .map(s => ({ ...s, original: ingredient }))
    .sort((a, b) => b.qualityScore - a.qualityScore);
}

export function listAvailableIngredients(): string[] {
  return Object.keys(SUBSTITUTIONS).sort();
}

// CLI entrypoint
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--list") {
    console.log("Available ingredients:", listAvailableIngredients().join(", "));
    process.exit(0);
  }

  const ingredient = args[0];
  const dietary = args.includes("--dietary") ? args[args.indexOf("--dietary") + 1] as DietaryTag : undefined;
  const role = args.includes("--role") ? args[args.indexOf("--role") + 1] as IngredientRole : undefined;

  const results = findSubstitutions(ingredient, dietary, role);

  if (results.length === 0) {
    console.log(`No substitutions found for "${ingredient}"${dietary ? ` (${dietary})` : ""}.`);
    console.log(`Available: ${listAvailableIngredients().join(", ")}`);
    process.exit(0);
  }

  console.log(`\n🔄 Substitutions for "${ingredient}"${dietary ? ` (${dietary})` : ""}:\n`);
  results.forEach((s, i) => {
    console.log(`${i + 1}. ${s.substitute} ${"⭐".repeat(s.qualityScore)}`);
    console.log(`   Ratio: ${s.ratio}`);
    console.log(`   ${s.notes}`);
    console.log();
  });

  if (args.includes("--json")) {
    console.log(JSON.stringify(results, null, 2));
  }

  if (results.length > 0) {
    notifySync(`Found ${results.length} substitutions for ${ingredient}`);
  }
}
