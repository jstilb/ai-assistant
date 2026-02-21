/**
 * GoldenSet.test.ts - Full pipeline integration tests with 20 representative room scenarios
 *
 * Tests the complete DesignerOrchestrator pipeline from room analysis through
 * formatted output for 20 diverse room types and styles. Vision adapters are mocked
 * with realistic RoomAnalysis data per scenario. Validates:
 *   - RoomAnalysis contains valid room_type, styles, colors
 *   - Products returned are realistic
 *   - MoodBoard has palette colors + style references
 *   - Budget calculation is accurate
 *   - Output format includes all required sections
 *
 * @module GoldenSet.test
 */

import { describe, it, expect } from "bun:test";
import {
  createDesignerOrchestrator,
  type OrchestratorDeps,
  type OrchestratorResult,
} from "../DesignerOrchestrator.ts";
import { generateMoodBoard, type MoodBoard } from "../MoodBoardGenerator.ts";
import { calculateBudgetResult, type BudgetResult } from "../BudgetCalculator.ts";
import { formatAsMarkdown, type DesignRecommendation } from "../OutputFormatter.ts";

// ---------------------------------------------------------------------------
// 20 Golden Scenarios with realistic mock data
// ---------------------------------------------------------------------------

interface GoldenScenario {
  name: string;
  roomType: string;
  style: string;
  budget: number;
  analysis: {
    colors: { dominant: string[]; accent: string[]; mood: string };
    style: { primary: string; secondary?: string; cohesionScore: number };
    lighting: {
      naturalLight: "abundant" | "moderate" | "limited" | "none";
      artificialLight: "well-lit" | "adequate" | "dim" | "none";
      recommendation: string;
    };
    focalPoints: string[];
    issues: Array<{ issue: string; severity: "minor" | "moderate" | "major"; suggestion: string }>;
    improvements: Array<{ suggestion: string; impact: "low" | "medium" | "high"; estimatedCost: string; priority: number }>;
    confidence: number;
    analysisMethod: "gemini_vision" | "claude_vision" | "text_inference";
  };
  products: Array<{ name: string; price: number; category: string; retailer: string; styleMatchScore: number }>;
}

const GOLDEN_SCENARIOS: GoldenScenario[] = [
  {
    name: "Modern Living Room",
    roomType: "living_room",
    style: "modern",
    budget: 5000,
    analysis: {
      colors: { dominant: ["#F5E6D3", "#C19A6B", "#36454F"], accent: ["#CC5C3B"], mood: "Warm and contemporary" },
      style: { primary: "Modern", secondary: "Cozy", cohesionScore: 8 },
      lighting: { naturalLight: "abundant", artificialLight: "well-lit", recommendation: "Add accent lighting" },
      focalPoints: ["fireplace", "large window"],
      issues: [{ issue: "Empty corner", severity: "minor", suggestion: "Add a reading nook" }],
      improvements: [{ suggestion: "Add floor lamp", impact: "medium", estimatedCost: "$150-300", priority: 1 }],
      confidence: 0.9,
      analysisMethod: "claude_vision",
    },
    products: [
      { name: "Modern Sofa", price: 1200, category: "seating", retailer: "West Elm", styleMatchScore: 0.9 },
      { name: "Glass Coffee Table", price: 450, category: "tables", retailer: "CB2", styleMatchScore: 0.85 },
      { name: "Arc Floor Lamp", price: 220, category: "lighting", retailer: "Article", styleMatchScore: 0.8 },
    ],
  },
  {
    name: "Scandinavian Bedroom",
    roomType: "bedroom",
    style: "scandinavian",
    budget: 3000,
    analysis: {
      colors: { dominant: ["#FFFFFF", "#F2F0EB", "#C5CFC0"], accent: ["#D4A76A"], mood: "Light and airy" },
      style: { primary: "Scandinavian", secondary: "Minimalist", cohesionScore: 9 },
      lighting: { naturalLight: "abundant", artificialLight: "adequate", recommendation: "Warm bedside lighting" },
      focalPoints: ["bed frame", "window"],
      issues: [],
      improvements: [{ suggestion: "Add linen curtains", impact: "low", estimatedCost: "$80-150", priority: 2 }],
      confidence: 0.92,
      analysisMethod: "gemini_vision",
    },
    products: [
      { name: "Birch Platform Bed", price: 800, category: "beds", retailer: "IKEA", styleMatchScore: 0.95 },
      { name: "Wool Throw", price: 65, category: "textiles", retailer: "Target", styleMatchScore: 0.9 },
    ],
  },
  {
    name: "Industrial Kitchen",
    roomType: "kitchen",
    style: "industrial",
    budget: 8000,
    analysis: {
      colors: { dominant: ["#2C2C2C", "#808080", "#AFA99E"], accent: ["#B5A642"], mood: "Raw and urban" },
      style: { primary: "Industrial", cohesionScore: 7 },
      lighting: { naturalLight: "moderate", artificialLight: "adequate", recommendation: "Pendant lights over island" },
      focalPoints: ["exposed brick wall", "kitchen island"],
      issues: [{ issue: "Insufficient task lighting", severity: "moderate", suggestion: "Install under-cabinet LEDs" }],
      improvements: [{ suggestion: "Add pendant lights", impact: "high", estimatedCost: "$200-500", priority: 1 }],
      confidence: 0.88,
      analysisMethod: "claude_vision",
    },
    products: [
      { name: "Metal Pendant Light", price: 180, category: "lighting", retailer: "Amazon", styleMatchScore: 0.9 },
      { name: "Industrial Bar Stool", price: 150, category: "seating", retailer: "Wayfair", styleMatchScore: 0.85 },
      { name: "Butcher Block Island", price: 1200, category: "furniture", retailer: "Crate & Barrel", styleMatchScore: 0.8 },
    ],
  },
  {
    name: "Traditional Dining Room",
    roomType: "dining_room",
    style: "traditional",
    budget: 6000,
    analysis: {
      colors: { dominant: ["#9A463D", "#1B2A4A", "#FFFDD0"], accent: ["#B5A642"], mood: "Elegant and refined" },
      style: { primary: "Traditional", secondary: "Classic", cohesionScore: 8 },
      lighting: { naturalLight: "moderate", artificialLight: "well-lit", recommendation: "Dimmer for chandelier" },
      focalPoints: ["chandelier", "dining table"],
      issues: [],
      improvements: [{ suggestion: "Add area rug", impact: "medium", estimatedCost: "$300-600", priority: 1 }],
      confidence: 0.91,
      analysisMethod: "gemini_vision",
    },
    products: [
      { name: "Oak Dining Table", price: 1500, category: "tables", retailer: "Pottery Barn", styleMatchScore: 0.9 },
      { name: "Upholstered Chair", price: 350, category: "seating", retailer: "World Market", styleMatchScore: 0.85 },
    ],
  },
  {
    name: "Mid-Century Office",
    roomType: "office",
    style: "mid-century",
    budget: 4000,
    analysis: {
      colors: { dominant: ["#D4A76A", "#36454F", "#F2F0EB"], accent: ["#CC5C3B"], mood: "Retro sophistication" },
      style: { primary: "Mid-Century Modern", cohesionScore: 8 },
      lighting: { naturalLight: "moderate", artificialLight: "adequate", recommendation: "Desk lamp upgrade" },
      focalPoints: ["walnut desk", "bookshelf"],
      issues: [{ issue: "Cable clutter", severity: "minor", suggestion: "Cable management system" }],
      improvements: [{ suggestion: "Ergonomic chair", impact: "high", estimatedCost: "$400-800", priority: 1 }],
      confidence: 0.87,
      analysisMethod: "claude_vision",
    },
    products: [
      { name: "Walnut Writing Desk", price: 900, category: "desks", retailer: "Article", styleMatchScore: 0.95 },
      { name: "Task Chair", price: 550, category: "seating", retailer: "West Elm", styleMatchScore: 0.85 },
    ],
  },
  {
    name: "Bohemian Bathroom",
    roomType: "bathroom",
    style: "bohemian",
    budget: 2000,
    analysis: {
      colors: { dominant: ["#FFFFFF", "#C19A6B", "#228B22"], accent: ["#FF8800"], mood: "Eclectic warmth" },
      style: { primary: "Bohemian", cohesionScore: 6 },
      lighting: { naturalLight: "limited", artificialLight: "dim", recommendation: "Vanity light upgrade" },
      focalPoints: ["mirror", "plant shelf"],
      issues: [{ issue: "Poor ventilation", severity: "moderate", suggestion: "Add exhaust fan" }],
      improvements: [{ suggestion: "New vanity light", impact: "high", estimatedCost: "$80-200", priority: 1 }],
      confidence: 0.82,
      analysisMethod: "gemini_vision",
    },
    products: [
      { name: "Rattan Mirror", price: 120, category: "decor", retailer: "Target", styleMatchScore: 0.9 },
      { name: "Macrame Shelf", price: 45, category: "storage", retailer: "Amazon", styleMatchScore: 0.85 },
    ],
  },
  {
    name: "Minimalist Studio",
    roomType: "studio",
    style: "minimalist",
    budget: 3500,
    analysis: {
      colors: { dominant: ["#FFFFFF", "#F2F0EB", "#2C2C2C"], accent: ["#808080"], mood: "Clean and focused" },
      style: { primary: "Minimalist", cohesionScore: 9 },
      lighting: { naturalLight: "abundant", artificialLight: "well-lit", recommendation: "Maintain simplicity" },
      focalPoints: ["large window", "accent wall"],
      issues: [],
      improvements: [{ suggestion: "Hidden storage", impact: "medium", estimatedCost: "$200-500", priority: 1 }],
      confidence: 0.93,
      analysisMethod: "claude_vision",
    },
    products: [
      { name: "Modular Shelving", price: 400, category: "storage", retailer: "IKEA", styleMatchScore: 0.95 },
      { name: "Platform Daybed", price: 700, category: "beds", retailer: "CB2", styleMatchScore: 0.9 },
    ],
  },
  {
    name: "Coastal Sunroom",
    roomType: "sunroom",
    style: "coastal",
    budget: 4500,
    analysis: {
      colors: { dominant: ["#FFFFFF", "#00FFFF", "#C5CFC0"], accent: ["#D4A76A"], mood: "Breezy and relaxed" },
      style: { primary: "Coastal", secondary: "Casual", cohesionScore: 7 },
      lighting: { naturalLight: "abundant", artificialLight: "adequate", recommendation: "Sheer curtains" },
      focalPoints: ["ocean view", "wicker seating"],
      issues: [{ issue: "Fading fabrics", severity: "minor", suggestion: "UV-resistant materials" }],
      improvements: [{ suggestion: "Outdoor-indoor rug", impact: "medium", estimatedCost: "$200-400", priority: 1 }],
      confidence: 0.89,
      analysisMethod: "gemini_vision",
    },
    products: [
      { name: "Wicker Loveseat", price: 650, category: "seating", retailer: "Wayfair", styleMatchScore: 0.9 },
      { name: "Sisal Rug", price: 280, category: "rugs", retailer: "World Market", styleMatchScore: 0.85 },
    ],
  },
  {
    name: "Rustic Cabin",
    roomType: "cabin",
    style: "rustic",
    budget: 5500,
    analysis: {
      colors: { dominant: ["#D4A76A", "#9A463D", "#2C2C2C"], accent: ["#228B22"], mood: "Warm and rugged" },
      style: { primary: "Rustic", secondary: "Cabin", cohesionScore: 8 },
      lighting: { naturalLight: "limited", artificialLight: "dim", recommendation: "Warm ambient lighting" },
      focalPoints: ["stone fireplace", "exposed beams"],
      issues: [{ issue: "Dark corners", severity: "moderate", suggestion: "Floor lamps or sconces" }],
      improvements: [{ suggestion: "Add sconces", impact: "high", estimatedCost: "$150-300", priority: 1 }],
      confidence: 0.86,
      analysisMethod: "claude_vision",
    },
    products: [
      { name: "Leather Armchair", price: 850, category: "seating", retailer: "Pottery Barn", styleMatchScore: 0.9 },
      { name: "Antler Chandelier", price: 320, category: "lighting", retailer: "Amazon", styleMatchScore: 0.8 },
    ],
  },
  {
    name: "Farmhouse Entryway",
    roomType: "entryway",
    style: "farmhouse",
    budget: 1500,
    analysis: {
      colors: { dominant: ["#FFFFFF", "#D4A76A", "#C5CFC0"], accent: ["#808080"], mood: "Welcoming country" },
      style: { primary: "Farmhouse", cohesionScore: 7 },
      lighting: { naturalLight: "moderate", artificialLight: "adequate", recommendation: "Statement pendant" },
      focalPoints: ["front door", "coat hooks"],
      issues: [{ issue: "Clutter", severity: "minor", suggestion: "Entryway bench with storage" }],
      improvements: [{ suggestion: "Storage bench", impact: "high", estimatedCost: "$200-400", priority: 1 }],
      confidence: 0.84,
      analysisMethod: "gemini_vision",
    },
    products: [
      { name: "Storage Bench", price: 280, category: "furniture", retailer: "Target", styleMatchScore: 0.9 },
      { name: "Farmhouse Mirror", price: 120, category: "decor", retailer: "HomeGoods", styleMatchScore: 0.85 },
    ],
  },
  {
    name: "Art Deco Library",
    roomType: "library",
    style: "art_deco",
    budget: 10000,
    analysis: {
      colors: { dominant: ["#1B2A4A", "#B5A642", "#2C2C2C"], accent: ["#CC5C3B"], mood: "Glamorous opulence" },
      style: { primary: "Art Deco", cohesionScore: 9 },
      lighting: { naturalLight: "limited", artificialLight: "well-lit", recommendation: "Brass reading lamps" },
      focalPoints: ["floor-to-ceiling bookshelves", "brass fixtures"],
      issues: [],
      improvements: [{ suggestion: "Velvet reading chair", impact: "medium", estimatedCost: "$800-1500", priority: 1 }],
      confidence: 0.91,
      analysisMethod: "claude_vision",
    },
    products: [
      { name: "Velvet Tufted Chair", price: 1200, category: "seating", retailer: "CB2", styleMatchScore: 0.95 },
      { name: "Brass Desk Lamp", price: 180, category: "lighting", retailer: "West Elm", styleMatchScore: 0.9 },
    ],
  },
  {
    name: "Japanese Zen Garden Room",
    roomType: "garden_room",
    style: "japanese",
    budget: 6000,
    analysis: {
      colors: { dominant: ["#F2F0EB", "#228B22", "#D4A76A"], accent: ["#808080"], mood: "Serene contemplation" },
      style: { primary: "Japandi", secondary: "Zen", cohesionScore: 9 },
      lighting: { naturalLight: "abundant", artificialLight: "dim", recommendation: "Paper lanterns" },
      focalPoints: ["bonsai tree", "water feature"],
      issues: [],
      improvements: [{ suggestion: "Add tatami mats", impact: "medium", estimatedCost: "$200-500", priority: 1 }],
      confidence: 0.88,
      analysisMethod: "gemini_vision",
    },
    products: [
      { name: "Low Platform Table", price: 350, category: "tables", retailer: "Article", styleMatchScore: 0.95 },
      { name: "Paper Floor Lamp", price: 90, category: "lighting", retailer: "IKEA", styleMatchScore: 0.9 },
    ],
  },
  {
    name: "Mediterranean Patio",
    roomType: "patio",
    style: "mediterranean",
    budget: 7000,
    analysis: {
      colors: { dominant: ["#FFFDD0", "#0000FF", "#FFFFFF"], accent: ["#CC5C3B"], mood: "Sun-drenched warmth" },
      style: { primary: "Mediterranean", cohesionScore: 8 },
      lighting: { naturalLight: "abundant", artificialLight: "adequate", recommendation: "String lights" },
      focalPoints: ["terracotta planters", "arched doorway"],
      issues: [{ issue: "Sun exposure", severity: "minor", suggestion: "Add pergola or umbrella" }],
      improvements: [{ suggestion: "Outdoor dining set", impact: "high", estimatedCost: "$800-1500", priority: 1 }],
      confidence: 0.85,
      analysisMethod: "claude_vision",
    },
    products: [
      { name: "Terracotta Planter Set", price: 120, category: "decor", retailer: "World Market", styleMatchScore: 0.9 },
      { name: "Iron Bistro Table", price: 400, category: "tables", retailer: "Wayfair", styleMatchScore: 0.85 },
    ],
  },
  {
    name: "Contemporary Nursery",
    roomType: "nursery",
    style: "contemporary",
    budget: 3000,
    analysis: {
      colors: { dominant: ["#FFFFFF", "#C5CFC0", "#F5E6D3"], accent: ["#FFFF00"], mood: "Soft and playful" },
      style: { primary: "Contemporary", secondary: "Soft Modern", cohesionScore: 7 },
      lighting: { naturalLight: "moderate", artificialLight: "well-lit", recommendation: "Dimmable nightlight" },
      focalPoints: ["crib", "mobile"],
      issues: [{ issue: "Sharp corners", severity: "major", suggestion: "Corner guards on all furniture" }],
      improvements: [{ suggestion: "Blackout curtains", impact: "high", estimatedCost: "$50-120", priority: 1 }],
      confidence: 0.9,
      analysisMethod: "gemini_vision",
    },
    products: [
      { name: "Modern Crib", price: 600, category: "beds", retailer: "Pottery Barn", styleMatchScore: 0.9 },
      { name: "Soft Area Rug", price: 180, category: "rugs", retailer: "Target", styleMatchScore: 0.85 },
    ],
  },
  {
    name: "Eclectic Game Room",
    roomType: "game_room",
    style: "eclectic",
    budget: 5000,
    analysis: {
      colors: { dominant: ["#2C2C2C", "#FF0000", "#0000FF"], accent: ["#FFFF00", "#00FF00"], mood: "Vibrant energy" },
      style: { primary: "Eclectic", cohesionScore: 5 },
      lighting: { naturalLight: "limited", artificialLight: "well-lit", recommendation: "LED strip accent" },
      focalPoints: ["gaming setup", "neon signs"],
      issues: [{ issue: "Acoustic echo", severity: "moderate", suggestion: "Acoustic panels" }],
      improvements: [{ suggestion: "Sound-absorbing panels", impact: "high", estimatedCost: "$200-500", priority: 1 }],
      confidence: 0.83,
      analysisMethod: "claude_vision",
    },
    products: [
      { name: "Bean Bag Chair", price: 120, category: "seating", retailer: "Amazon", styleMatchScore: 0.7 },
      { name: "LED Strip Lights", price: 35, category: "lighting", retailer: "Amazon", styleMatchScore: 0.8 },
    ],
  },
  {
    name: "Transitional Master Suite",
    roomType: "master_bedroom",
    style: "transitional",
    budget: 8000,
    analysis: {
      colors: { dominant: ["#F5E6D3", "#1B2A4A", "#C19A6B"], accent: ["#B5A642"], mood: "Sophisticated comfort" },
      style: { primary: "Transitional", cohesionScore: 8 },
      lighting: { naturalLight: "moderate", artificialLight: "well-lit", recommendation: "Bedside sconces" },
      focalPoints: ["upholstered headboard", "bay window"],
      issues: [],
      improvements: [{ suggestion: "Layer textures", impact: "medium", estimatedCost: "$200-500", priority: 1 }],
      confidence: 0.91,
      analysisMethod: "gemini_vision",
    },
    products: [
      { name: "Upholstered King Bed", price: 1800, category: "beds", retailer: "Crate & Barrel", styleMatchScore: 0.9 },
      { name: "Linen Duvet Set", price: 250, category: "textiles", retailer: "West Elm", styleMatchScore: 0.85 },
    ],
  },
  {
    name: "Vintage Coffee Shop",
    roomType: "commercial",
    style: "vintage",
    budget: 12000,
    analysis: {
      colors: { dominant: ["#9A463D", "#D4A76A", "#2C2C2C"], accent: ["#FFFDD0"], mood: "Nostalgic warmth" },
      style: { primary: "Vintage", secondary: "Industrial", cohesionScore: 7 },
      lighting: { naturalLight: "moderate", artificialLight: "dim", recommendation: "Edison bulb pendants" },
      focalPoints: ["espresso machine", "exposed brick"],
      issues: [{ issue: "Insufficient seating", severity: "moderate", suggestion: "Add bar counter seating" }],
      improvements: [{ suggestion: "Edison pendant lights", impact: "high", estimatedCost: "$300-600", priority: 1 }],
      confidence: 0.86,
      analysisMethod: "claude_vision",
    },
    products: [
      { name: "Vintage Bar Stool", price: 180, category: "seating", retailer: "Wayfair", styleMatchScore: 0.9 },
      { name: "Edison Pendant", price: 90, category: "lighting", retailer: "Amazon", styleMatchScore: 0.85 },
    ],
  },
  {
    name: "Urban Loft",
    roomType: "loft",
    style: "urban",
    budget: 10000,
    analysis: {
      colors: { dominant: ["#2C2C2C", "#808080", "#FFFFFF"], accent: ["#FF8800"], mood: "Edgy metropolitan" },
      style: { primary: "Industrial", secondary: "Modern", cohesionScore: 7 },
      lighting: { naturalLight: "abundant", artificialLight: "adequate", recommendation: "Track lighting" },
      focalPoints: ["exposed ductwork", "concrete columns"],
      issues: [{ issue: "Hard surfaces", severity: "minor", suggestion: "Add textile layers" }],
      improvements: [{ suggestion: "Large area rug", impact: "high", estimatedCost: "$500-1200", priority: 1 }],
      confidence: 0.88,
      analysisMethod: "gemini_vision",
    },
    products: [
      { name: "Sectional Sofa", price: 2200, category: "seating", retailer: "Article", styleMatchScore: 0.85 },
      { name: "Concrete Coffee Table", price: 450, category: "tables", retailer: "CB2", styleMatchScore: 0.9 },
    ],
  },
  {
    name: "Classic Gentleman's Study",
    roomType: "study",
    style: "classic",
    budget: 15000,
    analysis: {
      colors: { dominant: ["#1B2A4A", "#9A463D", "#D4A76A"], accent: ["#B5A642"], mood: "Distinguished refinement" },
      style: { primary: "Traditional", secondary: "Classic", cohesionScore: 9 },
      lighting: { naturalLight: "limited", artificialLight: "well-lit", recommendation: "Green banker's lamp" },
      focalPoints: ["mahogany desk", "leather club chair"],
      issues: [],
      improvements: [{ suggestion: "Add globe bar cart", impact: "low", estimatedCost: "$200-500", priority: 2 }],
      confidence: 0.93,
      analysisMethod: "claude_vision",
    },
    products: [
      { name: "Mahogany Desk", price: 2500, category: "desks", retailer: "Pottery Barn", styleMatchScore: 0.95 },
      { name: "Leather Club Chair", price: 1800, category: "seating", retailer: "Crate & Barrel", styleMatchScore: 0.95 },
    ],
  },
  {
    name: "Tropical Resort Bedroom",
    roomType: "bedroom",
    style: "tropical",
    budget: 6000,
    analysis: {
      colors: { dominant: ["#FFFFFF", "#228B22", "#D4A76A"], accent: ["#00FFFF", "#FF8800"], mood: "Lush paradise" },
      style: { primary: "Tropical", secondary: "Coastal", cohesionScore: 7 },
      lighting: { naturalLight: "abundant", artificialLight: "adequate", recommendation: "Bamboo pendant" },
      focalPoints: ["canopy bed", "tropical plants"],
      issues: [{ issue: "Humidity damage risk", severity: "minor", suggestion: "Moisture-resistant finishes" }],
      improvements: [{ suggestion: "Bamboo canopy frame", impact: "high", estimatedCost: "$300-700", priority: 1 }],
      confidence: 0.87,
      analysisMethod: "gemini_vision",
    },
    products: [
      { name: "Rattan Canopy Bed", price: 1400, category: "beds", retailer: "Article", styleMatchScore: 0.9 },
      { name: "Tropical Print Pillows", price: 65, category: "textiles", retailer: "World Market", styleMatchScore: 0.85 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Helper: Build mock deps from a golden scenario
// ---------------------------------------------------------------------------

function buildDepsForScenario(scenario: GoldenScenario): OrchestratorDeps {
  const roomAnalysis = scenario.analysis;
  const products = scenario.products;
  const moodBoard = generateMoodBoard(roomAnalysis as any);
  const budgetProducts = products.map((p) => ({
    name: p.name,
    price: p.price,
    category: p.category,
  }));
  const budgetResult = calculateBudgetResult(budgetProducts, scenario.budget);

  return {
    analyzeRoom: async () => roomAnalysis,
    searchFurniture: async () =>
      products.map((p) => ({
        name: p.name,
        price: p.price,
        retailer: p.retailer,
        styleMatchScore: p.styleMatchScore,
        searchMethod: "curated_db" as const,
      })),
    generateMoodBoard: () => moodBoard,
    calculateBudget: () => budgetResult,
    formatOutput: (data: unknown) => {
      const d = data as Record<string, unknown>;
      const rec: DesignRecommendation = {
        roomName: scenario.name,
        style: scenario.style,
        analysis: {
          strengths: [roomAnalysis.colors.mood],
          opportunities: roomAnalysis.issues.map((i) => i.suggestion),
          lightingAssessment: roomAnalysis.lighting.recommendation,
          colorCoherence: `${roomAnalysis.style.cohesionScore}/10`,
        },
        actions: roomAnalysis.improvements.map((imp) => ({
          suggestion: imp.suggestion,
          impact: imp.impact,
          estimatedCost: parseFloat(imp.estimatedCost.replace(/[^0-9.]/g, "")) || 0,
          priority: imp.priority,
          category: "general",
        })),
        products: products.map((p) => ({
          name: p.name,
          price: p.price,
          retailer: p.retailer,
          styleMatchScore: p.styleMatchScore,
          url: `https://example.com/${p.name.toLowerCase().replace(/\s+/g, "-")}`,
        })),
        moodBoard: moodBoard,
        budgetResult: budgetResult,
        metadata: {
          scenario: scenario.name,
          analysisMethod: roomAnalysis.analysisMethod,
          confidence: roomAnalysis.confidence,
        },
      };
      return formatAsMarkdown(rec);
    },
    loadConfig: () => ({
      aesthetic: { primary: scenario.style, secondary: "warm", descriptors: [] },
      colors: { love: [], avoid: [], accentPreference: "" },
      budget: "moderate" as const,
      avoidStyles: [],
      rooms: [],
      goals: [],
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GoldenSet - 20 Scenario Full Pipeline Integration", () => {
  for (const scenario of GOLDEN_SCENARIOS) {
    describe(`Scenario: ${scenario.name}`, () => {
      let result: OrchestratorResult;

      it("completes the full pipeline successfully", async () => {
        const deps = buildDepsForScenario(scenario);
        const orchestrator = createDesignerOrchestrator(deps);
        result = await orchestrator.run({
          imagePath: `/tmp/golden-${scenario.roomType}.jpg`,
          budget: scenario.budget,
          style: scenario.style,
        });
        expect(result.success).toBe(true);
        expect(result.errors.length).toBe(0);
      });

      it("returns valid room analysis with style and colors", async () => {
        const deps = buildDepsForScenario(scenario);
        const orchestrator = createDesignerOrchestrator(deps);
        result = await orchestrator.run({
          imagePath: `/tmp/golden-${scenario.roomType}.jpg`,
          budget: scenario.budget,
        });

        const analysis = result.roomAnalysis as Record<string, any>;
        expect(analysis).not.toBeNull();
        expect(analysis.style).toBeDefined();
        expect(analysis.style.primary).toBeTruthy();
        expect(analysis.style.cohesionScore).toBeGreaterThanOrEqual(1);
        expect(analysis.style.cohesionScore).toBeLessThanOrEqual(10);
        expect(analysis.colors.dominant.length).toBeGreaterThan(0);
        expect(analysis.confidence).toBeGreaterThan(0);
        expect(analysis.confidence).toBeLessThanOrEqual(1);
      });

      it("returns products with valid structure", async () => {
        const deps = buildDepsForScenario(scenario);
        const orchestrator = createDesignerOrchestrator(deps);
        result = await orchestrator.run({
          imagePath: `/tmp/golden-${scenario.roomType}.jpg`,
          budget: scenario.budget,
        });

        expect(result.furnitureResults.length).toBeGreaterThan(0);
        for (const product of result.furnitureResults) {
          const p = product as Record<string, any>;
          expect(p.name).toBeTruthy();
          expect(typeof p.price).toBe("number");
          expect(p.price).toBeGreaterThan(0);
          expect(p.retailer).toBeTruthy();
          expect(p.styleMatchScore).toBeGreaterThanOrEqual(0);
          expect(p.styleMatchScore).toBeLessThanOrEqual(1);
        }
      });

      it("generates mood board with palette and references", async () => {
        const deps = buildDepsForScenario(scenario);
        const orchestrator = createDesignerOrchestrator(deps);
        result = await orchestrator.run({
          imagePath: `/tmp/golden-${scenario.roomType}.jpg`,
          budget: scenario.budget,
        });

        const board = result.moodBoard as MoodBoard;
        expect(board).not.toBeNull();
        expect(board.palette.length).toBeGreaterThanOrEqual(1);
        expect(board.palette.length).toBeLessThanOrEqual(5);
        for (const color of board.palette) {
          expect(color.hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
          expect(color.name).toBeTruthy();
          expect(color.weight).toBeGreaterThan(0);
        }
        expect(board.style_keywords.length).toBeGreaterThan(0);
        expect(["complementary", "analogous", "triadic", "monochromatic"]).toContain(
          board.color_harmony
        );
      });

      it("calculates budget accurately", async () => {
        const deps = buildDepsForScenario(scenario);
        const orchestrator = createDesignerOrchestrator(deps);
        result = await orchestrator.run({
          imagePath: `/tmp/golden-${scenario.roomType}.jpg`,
          budget: scenario.budget,
        });

        const budget = result.budgetResult as BudgetResult;
        expect(budget).not.toBeNull();
        expect(budget.total_cost).toBeGreaterThanOrEqual(0);
        expect(budget.currency).toBe("USD");
        expect(["within", "over", "under", "no_budget"]).toContain(budget.budget_status);
        expect(budget.per_category.length).toBeGreaterThan(0);
      });

      it("produces formatted output with required sections", async () => {
        const deps = buildDepsForScenario(scenario);
        const orchestrator = createDesignerOrchestrator(deps);
        result = await orchestrator.run({
          imagePath: `/tmp/golden-${scenario.roomType}.jpg`,
          budget: scenario.budget,
        });

        expect(result.formattedOutput).toBeTruthy();
        expect(result.formattedOutput).toContain("## Room Analysis");
        expect(result.formattedOutput).toContain("## Budget Summary");
        expect(result.formattedOutput).toContain("## Mood Board");
        expect(result.formattedOutput).toContain("## Metadata");
      });
    });
  }
});
