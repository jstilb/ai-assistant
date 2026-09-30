#!/usr/bin/env bun
// LinkedIn Import Pipeline — Main Orchestrator
// Usage: bun run tools/LinkedInImport/index.ts [--dry-run]
//
// Parses LinkedIn export data and enriches NetworkMatch, JobBlitz, and JobHunter skills.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { stringify as yamlStringify } from "yaml";

import { parseMessages } from "./parsers/messages-parser.ts";
import { parseEndorsements } from "./parsers/endorsement-parser.ts";
import { parseRecommendations } from "./parsers/recommendation-parser.ts";
import { parseApplications } from "./parsers/application-parser.ts";

import { computeMessageSignals, applyMessageEnrichment } from "./enrichers/message-enricher.ts";
import { applyEndorsementEnrichment } from "./enrichers/endorsement-enricher.ts";
import { enrichApplications } from "./enrichers/application-enricher.ts";
import { extractTestimonials } from "./enrichers/testimonial-enricher.ts";

import { buildUrlIndex } from "./utils/url-normalizer.ts";

import type { NetworkGraph, NetworkNode, PipelineStats } from "./types.ts";

// ===== PATHS =====

const LINKEDIN_EXPORT_DIR = "/Users/[user]/Desktop/Complete_LinkedInDataExport_02-22-2026.zip";
const KAYA_DIR = "~/.claude";

const PATHS = {
  messages: join(LINKEDIN_EXPORT_DIR, "messages.csv"),
  endorsementsReceived: join(LINKEDIN_EXPORT_DIR, "Endorsement_Received_Info.csv"),
  endorsementsGiven: join(LINKEDIN_EXPORT_DIR, "Endorsement_Given_Info.csv"),
  recommendations: join(LINKEDIN_EXPORT_DIR, "Recommendations_Received.csv"),
  jobApps1: join(LINKEDIN_EXPORT_DIR, "Jobs", "Job Applications.csv"),
  jobApps2: join(LINKEDIN_EXPORT_DIR, "Jobs", "Job Applications_1.csv"),
  savedAnswers: join(LINKEDIN_EXPORT_DIR, "Jobs", "Job Applicant Saved Answers.csv"),
  screeningResponses1: join(LINKEDIN_EXPORT_DIR, "Job Applicant Saved Screening Question Responses.csv"),
  screeningResponses2: join(LINKEDIN_EXPORT_DIR, "Job Applicant Saved Screening Question Responses_1.csv"),

  networkGraph: join(KAYA_DIR, "skills", "NetworkMatch", "State", "network-graph.json"),
  applicationsJsonl: join(KAYA_DIR, "skills", "JobBlitz", "State", "applications.jsonl"),
  questionBank: join(KAYA_DIR, "skills", "JobBlitz", "State", "linkedin-question-bank.yaml"),
  testimonials: join(KAYA_DIR, "skills", "JobHunter", "State", "linkedin-testimonials.yaml"),
  backupBase: join(KAYA_DIR, "skills", "NetworkMatch", "State", "backups"),
};

// ===== HELPERS =====

function log(section: string, message: string): void {
  console.log(`[${section}] ${message}`);
}

function abort(message: string): never {
  console.error(`ABORT: ${message}`);
  process.exit(1);
}

function createBackup(timestamp: string): void {
  const backupDir = join(PATHS.backupBase, `pre-linkedin-import-${timestamp}`);
  mkdirSync(backupDir, { recursive: true });

  // Backup network-graph.json
  const graphDest = join(backupDir, "network-graph.json");
  copyFileSync(PATHS.networkGraph, graphDest);
  log("BACKUP", `network-graph.json → ${graphDest}`);

  // Backup applications.jsonl if it exists
  if (existsSync(PATHS.applicationsJsonl)) {
    const appsDest = join(backupDir, "applications.jsonl");
    copyFileSync(PATHS.applicationsJsonl, appsDest);
    log("BACKUP", `applications.jsonl → ${appsDest}`);
  }
}

function loadNetworkGraph(): NetworkGraph {
  try {
    const content = readFileSync(PATHS.networkGraph, "utf-8");
    return JSON.parse(content) as NetworkGraph;
  } catch (err) {
    abort(`Failed to parse network-graph.json: ${String(err)}`);
  }
}

function saveNetworkGraph(graph: NetworkGraph, dryRun: boolean): void {
  if (dryRun) return;
  const content = JSON.stringify(graph, null, 2);
  writeFileSync(PATHS.networkGraph, content, "utf-8");
}

function writeYamlFile(filePath: string, data: unknown, comment: string, dryRun: boolean): void {
  if (dryRun) return;
  const header = `# ${comment}\n`;
  const content = header + yamlStringify(data);
  writeFileSync(filePath, content, "utf-8");
}

// Ensure applications.jsonl exists (empty)
function ensureJsonlExists(): void {
  if (!existsSync(PATHS.applicationsJsonl)) {
    writeFileSync(PATHS.applicationsJsonl, "", "utf-8");
  }
}

// ===== MAIN =====

async function main(): Promise<void> {
  const startTime = Date.now();
  const dryRun = process.argv.includes("--dry-run");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  console.log(`\nLinkedIn Import Pipeline${dryRun ? " (DRY RUN)" : ""}`);
  console.log("=".repeat(50));

  // ===== PHASE 0: BACKUP =====
  if (!dryRun) {
    log("BACKUP", "Creating pre-mutation backup...");
    createBackup(timestamp);
    log("BACKUP", "Backup complete.");
  } else {
    log("BACKUP", "Dry run — skipping backup.");
  }

  // ===== LOAD NETWORK GRAPH =====
  log("SETUP", "Loading network-graph.json...");
  const graph = loadNetworkGraph();
  log("SETUP", `Loaded ${graph.nodes.length} nodes.`);

  // Build URL index
  const urlIndex = buildUrlIndex(graph.nodes);
  log("SETUP", `URL index built with ${urlIndex.size} entries.`);

  const stats: PipelineStats = {
    feature1: {
      totalMessages: 0,
      totalConversations: 0,
      matchedConversations: 0,
      matchRate: 0,
      updatedNodes: 0,
      strengthUpgrades: { toStrong: 0, toModerate: 0, toWeak: 0 },
      layoffSupportNodes: 0,
    },
    feature2: {
      endorsementsReceived: 0,
      endorsementsGiven: 0,
      matchedEndorsers: 0,
      recommenders: 0,
      champions: 0,
      strengthUpgrades: 0,
    },
    feature3: {
      totalApplicationsParsed: 0,
      newApplicationsImported: 0,
      duplicatesSkipped: 0,
      questionAnswerPairs: 0,
    },
    feature4: {
      recommendationsProcessed: 0,
      quotesExtracted: 0,
      themes: [],
    },
  };

  // ===== FEATURE 1: MESSAGE-BASED RELATIONSHIP INTELLIGENCE =====
  console.log("\n--- Feature 1: Message-Based Relationship Intelligence ---");

  log("Feature 1", "Parsing messages.csv...");
  const messagesResult = parseMessages(PATHS.messages);
  if (!messagesResult.success) {
    abort(`Failed to parse messages.csv: ${messagesResult.error.message}`);
  }

  const conversations = messagesResult.data;
  const totalMessages = Array.from(conversations.values()).reduce(
    (sum, c) => sum + c.messageCount,
    0
  );
  stats.feature1.totalMessages = totalMessages;
  stats.feature1.totalConversations = conversations.size;

  log(
    "Feature 1",
    `Parsed ${totalMessages} messages in ${conversations.size} conversations.`
  );

  // Compute signals
  const refDate = new Date();
  const enrichmentResult = computeMessageSignals(conversations, urlIndex, graph.nodes, refDate);
  const signalsMap = enrichmentResult.signalsMap;

  stats.feature1.matchedConversations = enrichmentResult.matchedCount;
  stats.feature1.matchRate =
    conversations.size > 0
      ? (enrichmentResult.matchedCount / conversations.size) * 100
      : 0;

  log(
    "Feature 1",
    `Matched ${enrichmentResult.matchedCount}/${conversations.size} conversations to graph nodes (${stats.feature1.matchRate.toFixed(1)}%).`
  );

  // Verify match quality — note: most message participants are non-connections (recruiters, etc.)
  // who are not in the graph. This is expected. We validate that URL format matching works
  // correctly by checking that matched conversations use the correct URL format.
  const bidirectionalConvs = Array.from(conversations.values()).filter((c) => c.bidirectional);
  const matchedBidirectional = Array.from(signalsMap.values()).filter(
    (s) => s.bidirectional
  ).length;

  // URL format sanity check: if we have 0 matches but many conversations, something is wrong
  if (enrichmentResult.matchedCount === 0 && conversations.size > 50) {
    abort(
      `Zero conversations matched to graph nodes — likely a URL format mismatch. ` +
        `Check that graph LinkedIn URLs match the messages.csv SENDER PROFILE URL format.`
    );
  }

  log(
    "Feature 1",
    `Bidirectional convs in graph: ${matchedBidirectional} matched (${bidirectionalConvs.length} total bidirectional, most with non-connections).`
  );

  // Apply message enrichment to nodes
  const STRENGTH_ORDER = ["dormant", "weak", "moderate", "strong"];
  let updatedNodes = 0;
  let layoffSupportNodes = 0;

  for (const node of graph.nodes) {
    const signals = signalsMap.get(node.id);
    if (!signals) continue;

    const prevStrength = node.relationship.strength;
    applyMessageEnrichment(node, signals);
    updatedNodes++;

    if (signals.layoffSupport) layoffSupportNodes++;

    const newStrength = node.relationship.strength;
    if (prevStrength !== newStrength) {
      if (newStrength === "strong") stats.feature1.strengthUpgrades.toStrong++;
      else if (newStrength === "moderate") stats.feature1.strengthUpgrades.toModerate++;
      else if (newStrength === "weak") stats.feature1.strengthUpgrades.toWeak++;
    }
  }

  stats.feature1.updatedNodes = updatedNodes;
  stats.feature1.layoffSupportNodes = layoffSupportNodes;

  log("Feature 1", `Updated ${updatedNodes} nodes with message intelligence.`);
  log(
    "Feature 1",
    `Strength upgrades — toStrong: ${stats.feature1.strengthUpgrades.toStrong}, toModerate: ${stats.feature1.strengthUpgrades.toModerate}, toWeak: ${stats.feature1.strengthUpgrades.toWeak}.`
  );
  log("Feature 1", `Layoff support nodes: ${layoffSupportNodes}.`);

  // ===== FEATURE 2: ENDORSEMENT/RECOMMENDATION STRENGTH BOOST =====
  console.log("\n--- Feature 2: Endorsement/Recommendation Strength Boost ---");

  log("Feature 2", "Parsing endorsement CSVs...");
  const endorsementResult = parseEndorsements(
    PATHS.endorsementsReceived,
    PATHS.endorsementsGiven
  );
  if (!endorsementResult.success) {
    abort(`Failed to parse endorsement CSVs: ${endorsementResult.error.message}`);
  }

  log("Feature 2", "Parsing recommendations...");
  const recommendationsResult = parseRecommendations(PATHS.recommendations);
  if (!recommendationsResult.success) {
    abort(`Failed to parse recommendations: ${recommendationsResult.error.message}`);
  }

  const endorsementData = endorsementResult.data;
  const recommendations = recommendationsResult.data;

  stats.feature2.endorsementsReceived = Array.from(
    endorsementData.received.values()
  ).reduce((sum, arr) => sum + arr.length, 0);
  stats.feature2.endorsementsGiven = Array.from(
    endorsementData.given.values()
  ).reduce((sum, arr) => sum + arr.length, 0);

  log(
    "Feature 2",
    `Endorsements — received: ${stats.feature2.endorsementsReceived}, given: ${stats.feature2.endorsementsGiven}.`
  );
  log("Feature 2", `Recommendations: ${recommendations.length}.`);

  const { nodes: enrichedNodes, stats: endorseStats } = applyEndorsementEnrichment(
    graph.nodes,
    endorsementData,
    recommendations,
    urlIndex,
    signalsMap
  );

  graph.nodes = enrichedNodes;
  stats.feature2.matchedEndorsers = endorseStats.matchedEndorsers;
  stats.feature2.recommenders = endorseStats.recommenders;
  stats.feature2.champions = endorseStats.champions;
  stats.feature2.strengthUpgrades = endorseStats.strengthUpgrades;

  log("Feature 2", `Matched ${endorseStats.matchedEndorsers} endorsers to graph nodes.`);
  log("Feature 2", `${endorseStats.recommenders} recommenders identified → set to strong.`);
  log("Feature 2", `${endorseStats.champions} champions (endorsed + bidirectional).`);
  log("Feature 2", `Strength upgrades applied: ${endorseStats.strengthUpgrades}.`);

  // Save network graph after features 1+2
  if (!dryRun) {
    log("WRITE", "Writing enriched network-graph.json...");
    saveNetworkGraph(graph, dryRun);
    log("WRITE", "network-graph.json saved.");
  }

  // ===== FEATURE 3: APPLICATION HISTORY DEDUP =====
  console.log("\n--- Feature 3: Application History Dedup ---");

  log("Feature 3", "Parsing job application CSVs...");
  const appParseResult = parseApplications(
    PATHS.jobApps1,
    PATHS.jobApps2,
    PATHS.savedAnswers,
    PATHS.screeningResponses1,
    PATHS.screeningResponses2
  );
  if (!appParseResult.success) {
    abort(`Failed to parse job applications: ${appParseResult.error.message}`);
  }

  const { applications, questionAnswers } = appParseResult.data;
  stats.feature3.totalApplicationsParsed = applications.length;

  log("Feature 3", `Parsed ${applications.length} job applications.`);
  log("Feature 3", `Found ${questionAnswers.length} unique Q&A pairs.`);

  ensureJsonlExists();

  const appEnrichResult = enrichApplications(
    applications,
    PATHS.applicationsJsonl,
    dryRun
  );
  if (!appEnrichResult.success) {
    abort(`Failed to enrich applications: ${appEnrichResult.error.message}`);
  }

  stats.feature3.newApplicationsImported = appEnrichResult.data.newEntries.length;
  stats.feature3.duplicatesSkipped = appEnrichResult.data.duplicatesSkipped;
  stats.feature3.questionAnswerPairs = questionAnswers.length;

  log(
    "Feature 3",
    `${appEnrichResult.data.newEntries.length} new entries appended, ${appEnrichResult.data.duplicatesSkipped} duplicates skipped.`
  );

  // Write question bank
  if (!dryRun) {
    log("Feature 3", "Writing linkedin-question-bank.yaml...");
    const questionBankData = {
      screening_questions: questionAnswers,
    };
    writeYamlFile(
      PATHS.questionBank,
      questionBankData,
      `Auto-imported from LinkedIn export on ${new Date().toISOString().slice(0, 10)}`,
      dryRun
    );
    log("Feature 3", `Question bank written: ${questionAnswers.length} Q&A pairs.`);
  }

  // ===== FEATURE 4: RECOMMENDATION → COVER LETTER AMMUNITION =====
  console.log("\n--- Feature 4: Recommendation Cover Letter Ammunition ---");

  log("Feature 4", "Extracting testimonial quotes...");
  const testimonialsResult = extractTestimonials(recommendations);
  if (!testimonialsResult.success) {
    abort(`Failed to extract testimonials: ${testimonialsResult.error.message}`);
  }

  const testimonialsData = testimonialsResult.data;
  const totalQuotes = testimonialsData.testimonials.reduce(
    (sum, t) => sum + t.quotes.length,
    0
  );
  const allThemes = new Set<string>();
  for (const t of testimonialsData.testimonials) {
    for (const q of t.quotes) {
      for (const theme of q.themes) allThemes.add(theme);
    }
  }

  stats.feature4.recommendationsProcessed = recommendations.length;
  stats.feature4.quotesExtracted = totalQuotes;
  stats.feature4.themes = Array.from(allThemes);

  log(
    "Feature 4",
    `Extracted ${totalQuotes} quotes from ${recommendations.length} recommendations across ${allThemes.size} themes.`
  );

  if (!dryRun) {
    log("Feature 4", "Writing linkedin-testimonials.yaml...");
    writeYamlFile(
      PATHS.testimonials,
      testimonialsData,
      `LinkedIn Recommendation Quotes — Imported ${new Date().toISOString().slice(0, 10)}`,
      dryRun
    );
    log("Feature 4", "linkedin-testimonials.yaml written.");
  }

  // ===== SUMMARY =====
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log("\n" + "=".repeat(50));
  console.log("ENRICHMENT SUMMARY");
  console.log("=".repeat(50));
  console.log(
    `Feature 1 — Messages: ${stats.feature1.updatedNodes} nodes enriched, ${stats.feature1.matchRate.toFixed(1)}% match rate`
  );
  console.log(
    `  Strength upgrades: ${stats.feature1.strengthUpgrades.toStrong} →strong, ${stats.feature1.strengthUpgrades.toModerate} →moderate, ${stats.feature1.strengthUpgrades.toWeak} →weak`
  );
  console.log(
    `Feature 2 — Endorsements: ${stats.feature2.matchedEndorsers} endorsers, ${stats.feature2.recommenders} recommenders, ${stats.feature2.champions} champions`
  );
  console.log(
    `Feature 3 — Applications: ${stats.feature3.newApplicationsImported} imported, ${stats.feature3.duplicatesSkipped} skipped, ${stats.feature3.questionAnswerPairs} Q&A pairs`
  );
  console.log(
    `Feature 4 — Testimonials: ${stats.feature4.quotesExtracted} quotes from ${stats.feature4.recommendationsProcessed} recommendations, themes: ${stats.feature4.themes.join(", ")}`
  );
  console.log(`\nCompleted in ${elapsed}s${dryRun ? " (DRY RUN — no files written)" : ""}`);

  if (!dryRun) {
    console.log(`\nBackup: ${join(PATHS.backupBase, "pre-linkedin-import-" + timestamp)}`);
  }

  // Output JSON summary for orchestrator consumption
  const result = {
    success: true,
    dryRun,
    stats,
    elapsed: parseFloat(elapsed),
    timestamp,
  };
  console.log("\n" + JSON.stringify(result, null, 2));
}

main().catch((err: unknown) => {
  console.error("Fatal error:", String(err));
  process.exit(1);
});
