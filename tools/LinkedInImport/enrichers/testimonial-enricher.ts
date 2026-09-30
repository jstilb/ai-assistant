// Testimonial Enricher — extracts quotable phrases from recommendations, categorizes by theme
import type { ParsedRecommendation } from "../parsers/recommendation-parser.ts";
import type { Testimonial, TestimonialQuote, TestimonialsFile, Result } from "../types.ts";

// Theme definitions — keyword lists
const THEMES: Record<string, string[]> = {
  data_analytics: [
    "data",
    "analytics",
    "business intelligence",
    "bi",
    "reporting",
    "analysis",
    "analyze",
    "metrics",
    "dashboard",
    "kpi",
    "sql",
    "insights",
    "drill down",
  ],
  leadership: [
    "leadership",
    "lead",
    "leading",
    "driven",
    "driving",
    "motivat",
    "path",
    "direction",
    "initiative",
    "create his own",
    "going above",
  ],
  teamwork: [
    "team",
    "collaboration",
    "collaborat",
    "culture",
    "colleague",
    "working with",
    "together",
    "partner",
    "member",
  ],
  work_ethic: [
    "grit",
    "growth",
    "improve",
    "drive",
    "driven",
    "efficiency",
    "work ethic",
    "continuously",
    "hard work",
    "above and beyond",
    "constantly",
    "learn",
    "entrepreneurial",
    "smarter",
  ],
  communication: [
    "storytelling",
    "story",
    "articulat",
    "present",
    "client meeting",
    "communicat",
    "explain",
    "voice",
    "speak",
  ],
  personality: [
    "fun",
    "humor",
    "funny",
    "culture",
    "positive",
    "attitude",
    "joy",
    "laugh",
    "awesome",
    "great to have",
    "quick with",
    "joke",
  ],
};

const ALL_THEMES = Object.keys(THEMES);

// Classify themes for a given sentence
function classifyThemes(sentence: string): string[] {
  const lower = sentence.toLowerCase();
  const matchedThemes: string[] = [];

  for (const [theme, keywords] of Object.entries(THEMES)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      matchedThemes.push(theme);
    }
  }

  return matchedThemes;
}

// Split text into sentences
function splitIntoSentences(text: string): string[] {
  // Split on ". ", "! ", "? " while handling common abbreviations
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20); // Filter very short fragments
  return sentences;
}

// Determine if a sentence is quotable
function isQuotable(sentence: string): boolean {
  const lower = sentence.toLowerCase();

  // Skip filler openers
  const FILLER_OPENERS = [
    "i had the pleasure",
    "it is my pleasure",
    "i am pleased to",
    "i have had the",
    "i am writing to",
    "i have known",
    "i am happy to",
  ];
  if (FILLER_OPENERS.some((f) => lower.startsWith(f))) return false;

  // Must contain some praise signal
  const PRAISE_SIGNALS = [
    "impressive",
    "second to none",
    "go-to",
    "best",
    "outstanding",
    "exceptional",
    "rare",
    "truly",
    "always",
    "consistently",
    "above and beyond",
    "i know i learned",
    "sure you will",
    "grit",
    "great",
    "awesome",
    "lucky to have",
    "smart way",
    "fantastic",
    "pushing",
    "motivating",
    "impactful",
    "holistic",
    "deep analytics",
    "entrepreneurial",
  ];

  const hasPraise = PRAISE_SIGNALS.some((p) => lower.includes(p));
  const hasTheme = ALL_THEMES.some((theme) =>
    THEMES[theme].some((kw) => lower.includes(kw))
  );

  return hasPraise || hasTheme;
}

// Extract quotes from a single recommendation
function extractQuotes(text: string): TestimonialQuote[] {
  const sentences = splitIntoSentences(text);
  const quotes: TestimonialQuote[] = [];

  for (const sentence of sentences) {
    if (!isQuotable(sentence)) continue;

    const themes = classifyThemes(sentence);
    if (themes.length === 0) {
      // Assign a default theme based on content if available
      themes.push("work_ethic"); // fallback theme
    }

    quotes.push({
      text: sentence,
      themes,
    });
  }

  // Ensure at least 3 quotes per recommendation by lowering the bar if needed
  if (quotes.length < 3) {
    for (const sentence of sentences) {
      if (quotes.some((q) => q.text === sentence)) continue; // already included
      if (sentence.length < 30) continue;

      const themes = classifyThemes(sentence);
      if (themes.length === 0) themes.push("work_ethic");

      quotes.push({ text: sentence, themes });
      if (quotes.length >= 3) break;
    }
  }

  return quotes;
}

export function extractTestimonials(
  recommendations: ParsedRecommendation[]
): Result<TestimonialsFile> {
  const testimonials: Testimonial[] = [];
  let totalQuotes = 0;

  for (const rec of recommendations) {
    const quotes = extractQuotes(rec.text);

    // Ensure at least 3 quotes
    if (quotes.length < 3) {
      // Split more aggressively if needed
      const parts = rec.text.split(/[.!?]/).map((s) => s.trim()).filter((s) => s.length > 25);
      for (const part of parts) {
        if (quotes.some((q) => q.text.includes(part.slice(0, 30)))) continue;
        const themes = classifyThemes(part);
        if (themes.length === 0) themes.push("work_ethic");
        quotes.push({ text: part + ".", themes });
        if (quotes.length >= 4) break;
      }
    }

    totalQuotes += quotes.length;

    testimonials.push({
      attribution: {
        firstName: rec.firstName,
        lastName: rec.lastName,
        role: rec.jobTitle,
        company: rec.company,
        date: rec.date,
      },
      quotes,
      fullText: rec.text,
    });
  }

  if (totalQuotes < 18) {
    console.warn(
      `Warning: Only ${totalQuotes} quotes extracted (target ≥18 across ${recommendations.length} recommendations)`
    );
  }

  return { success: true, data: { testimonials } };
}
