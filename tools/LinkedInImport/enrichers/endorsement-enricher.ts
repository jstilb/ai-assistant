// Endorsement Enricher — applies strength boosts, champions, recommender flags
import { matchUrlToNodeId } from "../utils/url-normalizer.ts";
import type {
  NetworkNode,
  RelationshipStrength,
  NodeEndorsements,
  EndorsementRecord,
} from "../types.ts";
import type { ParsedEndorsementData } from "../parsers/endorsement-parser.ts";
import type { ParsedRecommendation } from "../parsers/recommendation-parser.ts";
import type { ConversationSignals } from "../types.ts";

const STRENGTH_ORDER: RelationshipStrength[] = ["dormant", "weak", "moderate", "strong"];

function upgradeStrengthByOne(current: RelationshipStrength): RelationshipStrength {
  const idx = STRENGTH_ORDER.indexOf(current);
  if (idx === -1) return "weak";
  if (idx >= STRENGTH_ORDER.length - 1) return "strong"; // cap at strong
  return STRENGTH_ORDER[idx + 1];
}

function maxStrength(a: RelationshipStrength, b: RelationshipStrength): RelationshipStrength {
  return STRENGTH_ORDER.indexOf(a) >= STRENGTH_ORDER.indexOf(b) ? a : b;
}

export interface EndorsementEnrichmentStats {
  matchedEndorsers: number;
  unmatchedEndorsers: number;
  recommenders: number;
  champions: number;
  strengthUpgrades: number;
}

// Build a set of nodeIds that had bidirectional message conversations (for champion detection)
function buildBidirectionalSet(signalsMap: Map<string, ConversationSignals>): Set<string> {
  const set = new Set<string>();
  for (const [nodeId, signals] of signalsMap) {
    if (signals.bidirectional) set.add(nodeId);
  }
  return set;
}

export function applyEndorsementEnrichment(
  nodes: NetworkNode[],
  endorsementData: ParsedEndorsementData,
  recommendations: ParsedRecommendation[],
  urlIndex: Map<string, string>,
  signalsMap: Map<string, ConversationSignals>
): { nodes: NetworkNode[]; stats: EndorsementEnrichmentStats } {
  const nodeById = new Map<string, NetworkNode>(nodes.map((n) => [n.id, n]));
  const bidirectionalSet = buildBidirectionalSet(signalsMap);

  const stats: EndorsementEnrichmentStats = {
    matchedEndorsers: 0,
    unmatchedEndorsers: 0,
    recommenders: 0,
    champions: 0,
    strengthUpgrades: 0,
  };

  // Build recommender name → nodeId lookup (recommendations don't have URLs)
  // We'll match by name in the network graph
  const recommenderNames = new Set<string>(
    recommendations.map((r) => `${r.firstName.toLowerCase()} ${r.lastName.toLowerCase()}`)
  );

  // First pass: flag recommenders by name match
  const recommenderNodeIds = new Set<string>();
  for (const node of nodes) {
    const name = node.name.toLowerCase();
    if (recommenderNames.has(name)) {
      recommenderNodeIds.add(node.id);
    }
  }

  // Process endorsements received — upgrade strength by one level per endorser (not per endorsement)
  const endorserNodeIds = new Set<string>();
  const endorserReceivedMap = new Map<string, EndorsementRecord[]>(); // nodeId -> records

  for (const [endorserUrl, records] of endorsementData.received) {
    const nodeId = matchUrlToNodeId(endorserUrl, urlIndex);
    if (!nodeId) {
      stats.unmatchedEndorsers++;
      continue;
    }
    endorserNodeIds.add(nodeId);
    const existing = endorserReceivedMap.get(nodeId) ?? [];
    endorserReceivedMap.set(nodeId, [...existing, ...records]);
  }

  // Process endorsements given — store on nodes we endorsed
  const endorserGivenMap = new Map<string, EndorsementRecord[]>(); // nodeId -> records
  for (const [endorseeUrl, records] of endorsementData.given) {
    const nodeId = matchUrlToNodeId(endorseeUrl, urlIndex);
    if (!nodeId) continue;
    const existing = endorserGivenMap.get(nodeId) ?? [];
    endorserGivenMap.set(nodeId, [...existing, ...records]);
  }

  stats.matchedEndorsers = endorserNodeIds.size;

  // Apply to nodes
  for (const nodeId of endorserNodeIds) {
    const node = nodeById.get(nodeId);
    if (!node) continue;

    const currentStrength = node.relationship.strength;
    const newStrength = upgradeStrengthByOne(currentStrength);

    // Never downgrade
    if (STRENGTH_ORDER.indexOf(newStrength) > STRENGTH_ORDER.indexOf(currentStrength)) {
      node.relationship.strength = newStrength;
      stats.strengthUpgrades++;
    }

    // Build endorsements object
    const received = endorserReceivedMap.get(nodeId) ?? [];
    const given = endorserGivenMap.get(nodeId) ?? [];
    const isRecommender = recommenderNodeIds.has(nodeId);
    const isChampion = endorserNodeIds.has(nodeId) && bidirectionalSet.has(nodeId);

    const endorsements: NodeEndorsements = {
      received,
      given,
      isRecommender,
      isChampion,
    };

    if (!node.endorsements) {
      node.endorsements = endorsements;
    } else {
      // Merge — don't duplicate entries
      node.endorsements.received = [...node.endorsements.received, ...received];
      node.endorsements.given = [...node.endorsements.given, ...given];
      node.endorsements.isRecommender = node.endorsements.isRecommender || isRecommender;
      node.endorsements.isChampion = node.endorsements.isChampion || isChampion;
    }

    if (isChampion) stats.champions++;
    node.updatedAt = new Date().toISOString();
  }

  // Apply recommender upgrades — set to strong unconditionally
  for (const nodeId of recommenderNodeIds) {
    const node = nodeById.get(nodeId);
    if (!node) continue;

    // Always set to strong (never downgrade handled implicitly since strong is max)
    node.relationship.strength = "strong";
    stats.recommenders++;

    // Initialize or update endorsements
    if (!node.endorsements) {
      node.endorsements = {
        received: endorserReceivedMap.get(nodeId) ?? [],
        given: endorserGivenMap.get(nodeId) ?? [],
        isRecommender: true,
        isChampion: bidirectionalSet.has(nodeId) && endorserNodeIds.has(nodeId),
      };
    } else {
      node.endorsements.isRecommender = true;
      if (bidirectionalSet.has(nodeId) && endorserNodeIds.has(nodeId)) {
        node.endorsements.isChampion = true;
      }
    }

    node.updatedAt = new Date().toISOString();
  }

  // Handle nodes with only given endorsements (we endorsed them but they didn't endorse us)
  for (const [nodeId, records] of endorserGivenMap) {
    if (endorserNodeIds.has(nodeId)) continue; // already handled
    const node = nodeById.get(nodeId);
    if (!node) continue;

    if (!node.endorsements) {
      node.endorsements = {
        received: [],
        given: records,
        isRecommender: recommenderNodeIds.has(nodeId),
        isChampion: false,
      };
    } else {
      node.endorsements.given = [...node.endorsements.given, ...records];
    }
    node.updatedAt = new Date().toISOString();
  }

  return { nodes: Array.from(nodeById.values()), stats };
}
