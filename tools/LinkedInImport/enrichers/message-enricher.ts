// Message Enricher — classifies conversations, derives signals, upgrades strength
import { matchUrlToNodeId } from "../utils/url-normalizer.ts";
import { toISODate, isWithinDays, isLayoffPeriod } from "../utils/date-parser.ts";
import type {
  ConversationData,
  ConversationSignals,
  ConversationType,
  RelationshipStrength,
  NetworkNode,
  MessageIntelligence,
} from "../types.ts";

// ===== KEYWORD SETS =====

const RECRUITER_KEYWORDS = [
  "opportunity",
  "position",
  "role",
  "hiring",
  "job opening",
  "job opportunity",
  "candidate",
  "recruiting",
  "recruiter",
  "talent",
  "staffing",
  "interview",
  "compensation",
  "salary",
  "rate",
  "contract",
  "permanent",
  "full-time",
  "part-time",
  "relocation",
  "remote",
  "hybrid",
  "i came across your profile",
  "your background",
  "perfect fit",
  "great fit",
  "great match",
];

const SPAM_KEYWORDS = [
  "free website",
  "free trial",
  "special offer",
  "limited time",
  "click here",
  "unsubscribe",
  "marketing services",
  "lead generation",
  "social media management",
  "seo services",
  "web design",
  "app development",
  "advertisement",
  "sponsored",
  "promotional",
  "discount",
  "sale",
];

const LAYOFF_SUPPORT_KEYWORDS = [
  "sorry to hear",
  "hope you land",
  "let me know if i can help",
  "here if you need",
  "rooting for you",
  "you got this",
  "you'll find",
  "wishing you",
  "reach out if",
  "keep me posted",
  "connections you have",
  "lucky to have you",
  "wherever you go",
  "grateful for the opportunity",
  "enjoyed working with you",
  "really appreciate it",
];

function countKeywordMatches(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.filter((kw) => lower.includes(kw)).length;
}

function hasLayoffSupport(conv: ConversationData): boolean {
  // Check messages from Feb 2026
  for (const msg of conv.messages) {
    if (isLayoffPeriod(msg.date)) {
      const lower = msg.content.toLowerCase();
      const matches = LAYOFF_SUPPORT_KEYWORDS.filter((kw) => lower.includes(kw)).length;
      if (matches >= 1) return true;
    }
  }
  return false;
}

function classifyConversation(conv: ConversationData): ConversationType {
  const content = conv.plainTextContent.toLowerCase();

  // Bidirectional with multiple Jm messages → genuine or professional
  if (conv.bidirectional && conv.jmMessageCount >= 2) {
    const recruiterScore = countKeywordMatches(content, RECRUITER_KEYWORDS);
    const spamScore = countKeywordMatches(content, SPAM_KEYWORDS);
    if (recruiterScore >= 3 && conv.jmMessageCount <= 1) return "recruiter_inbound";
    if (spamScore >= 3) return "spam";
    return "genuine_relationship";
  }

  // One-way inbound check
  if (!conv.bidirectional || conv.jmMessageCount === 0) {
    const recruiterScore = countKeywordMatches(content, RECRUITER_KEYWORDS);
    const spamScore = countKeywordMatches(content, SPAM_KEYWORDS);
    if (spamScore >= 2) return "spam";
    if (recruiterScore >= 2) return "recruiter_inbound";
    return "professional_inquiry"; // conservative default
  }

  // Bidirectional but low Jm messages (1 reply)
  const recruiterScore = countKeywordMatches(content, RECRUITER_KEYWORDS);
  if (recruiterScore >= 2) return "recruiter_inbound";

  return "professional_inquiry";
}

// Compute strength upgrade based on signals
function computeStrengthUpgrade(
  conv: ConversationData,
  convType: ConversationType,
  layoffSupport: boolean,
  currentStrength: RelationshipStrength,
  refDate: Date
): RelationshipStrength | null {
  const STRENGTH_ORDER: RelationshipStrength[] = ["dormant", "weak", "moderate", "strong"];

  function maxStrength(a: RelationshipStrength, b: RelationshipStrength): RelationshipStrength {
    return STRENGTH_ORDER.indexOf(a) > STRENGTH_ORDER.indexOf(b) ? a : b;
  }

  function upgradeIfHigher(target: RelationshipStrength): RelationshipStrength | null {
    if (STRENGTH_ORDER.indexOf(target) > STRENGTH_ORDER.indexOf(currentStrength)) {
      return target;
    }
    return null;
  }

  if (convType === "recruiter_inbound" || convType === "spam") {
    return null; // No change
  }

  if (conv.bidirectional) {
    // Layoff support → always strong
    if (layoffSupport) return upgradeIfHigher("strong");

    // Bidirectional + recent + many messages → strong
    const isRecent = isWithinDays(conv.latestDate, refDate, 90);
    if (isRecent && conv.messageCount >= 3) return upgradeIfHigher("strong");

    // Bidirectional + older → at least moderate
    return upgradeIfHigher("moderate");
  }

  // One-way genuine → at least weak
  if (convType === "genuine_relationship" || convType === "professional_inquiry") {
    return upgradeIfHigher("weak");
  }

  return null;
}

function generateConversationSummary(conv: ConversationData, convType: ConversationType): string {
  if (convType === "recruiter_inbound") {
    return `Recruiter outreach conversation (${conv.messageCount} messages, ${toISODate(conv.latestDate)}).`;
  }
  if (convType === "spam") {
    return `Unsolicited marketing/spam message (${toISODate(conv.latestDate)}).`;
  }

  const direction = conv.bidirectional ? "Bidirectional" : "One-way";
  const msgCount = conv.messageCount;
  const date = toISODate(conv.latestDate);
  const layoff = hasLayoffSupport(conv) ? " Includes layoff support messages." : "";

  // Try to extract meaningful context from first message
  const firstMsg = conv.messages[0];
  const snippet = firstMsg
    ? firstMsg.content.slice(0, 80).replace(/\s+/g, " ").trim()
    : "";
  const snippetStr = snippet ? ` Topic: "${snippet}..."` : "";

  return `${direction} conversation — ${msgCount} messages, last contact ${date}.${layoff}${snippetStr}`;
}

export interface MessageEnrichmentResult {
  nodeId: string;
  signalsMap: Map<string, ConversationSignals>;
  matchedCount: number;
  unmatchedConversationIds: string[];
}

export function computeMessageSignals(
  conversations: Map<string, ConversationData>,
  urlIndex: Map<string, string>,
  nodes: NetworkNode[],
  refDate: Date
): MessageEnrichmentResult {
  const nodeById = new Map<string, NetworkNode>(nodes.map((n) => [n.id, n]));
  const signalsMap = new Map<string, ConversationSignals>();
  const unmatchedConversationIds: string[] = [];
  let matchedCount = 0;

  for (const [convId, conv] of conversations) {
    // Find the non-Jm participant URL
    let matchedNodeId: string | null = null;
    let matchedParticipantUrl = "";

    for (const participantUrl of conv.participants) {
      const nodeId = matchUrlToNodeId(participantUrl, urlIndex);
      if (nodeId) {
        matchedNodeId = nodeId;
        matchedParticipantUrl = participantUrl;
        break;
      }
    }

    if (!matchedNodeId) {
      unmatchedConversationIds.push(convId);
      continue;
    }

    matchedCount++;
    const node = nodeById.get(matchedNodeId);
    const currentStrength = node?.relationship.strength ?? "weak";

    const convType = classifyConversation(conv);
    const layoffSupport = hasLayoffSupport(conv);
    const strengthUpgrade = computeStrengthUpgrade(
      conv,
      convType,
      layoffSupport,
      currentStrength,
      refDate
    );

    // Determine lastMessageFrom
    const lastMsg = conv.messages[conv.messages.length - 1];
    const lastMessageFrom: "jm" | "contact" = lastMsg?.isFromJm ? "jm" : "contact";

    const signals: ConversationSignals = {
      conversationId: convId,
      participantUrl: matchedParticipantUrl,
      nodeId: matchedNodeId,
      conversationType: convType,
      totalMessages: conv.messageCount,
      bidirectional: conv.bidirectional,
      lastContact: conv.latestDate,
      lastMessageFrom,
      layoffSupport,
      conversationSummary: generateConversationSummary(conv, convType),
      strengthUpgrade,
    };

    // If this node already has signals (multiple conversations), merge
    const existing = signalsMap.get(matchedNodeId);
    if (existing) {
      // Keep later lastContact
      if (conv.latestDate > existing.lastContact) {
        existing.lastContact = conv.latestDate;
        existing.lastMessageFrom = lastMessageFrom;
      }
      // Accumulate message count
      existing.totalMessages += conv.messageCount;
      // OR flags
      if (conv.bidirectional) existing.bidirectional = true;
      if (layoffSupport) existing.layoffSupport = true;
      // Take the higher strength upgrade
      const STRENGTH_ORDER: RelationshipStrength[] = ["dormant", "weak", "moderate", "strong"];
      if (
        strengthUpgrade &&
        (!existing.strengthUpgrade ||
          STRENGTH_ORDER.indexOf(strengthUpgrade) >
            STRENGTH_ORDER.indexOf(existing.strengthUpgrade))
      ) {
        existing.strengthUpgrade = strengthUpgrade;
      }
      // Append summary
      existing.conversationSummary += " | " + signals.conversationSummary;
    } else {
      signalsMap.set(matchedNodeId, signals);
    }
  }

  return {
    nodeId: "", // not used at top level
    signalsMap,
    matchedCount,
    unmatchedConversationIds,
  };
}

// Apply message enrichment to a node — returns mutated node
export function applyMessageEnrichment(
  node: NetworkNode,
  signals: ConversationSignals
): NetworkNode {
  const STRENGTH_ORDER: RelationshipStrength[] = ["dormant", "weak", "moderate", "strong"];

  // Update lastContact (use later date)
  const existingLastContact = node.relationship.lastContact
    ? new Date(node.relationship.lastContact + "T00:00:00Z")
    : null;
  const newLastContact = signals.lastContact;
  const shouldUpdateContact =
    !existingLastContact || newLastContact > existingLastContact;

  if (shouldUpdateContact) {
    node.relationship.lastContact = toISODate(newLastContact);
  }

  // Upgrade strength — never downgrade
  if (signals.strengthUpgrade) {
    const current = node.relationship.strength;
    const newStrength = signals.strengthUpgrade;
    if (STRENGTH_ORDER.indexOf(newStrength) > STRENGTH_ORDER.indexOf(current)) {
      node.relationship.strength = newStrength;
    }
  }

  // Add messageIntelligence
  const msgIntel: MessageIntelligence = {
    totalMessages: signals.totalMessages,
    bidirectional: signals.bidirectional,
    conversationType: signals.conversationType,
    lastMessageDate: toISODate(signals.lastContact),
    lastMessageFrom: signals.lastMessageFrom,
    conversationSummary: signals.conversationSummary.slice(0, 500),
  };
  node.messageIntelligence = msgIntel;

  // Append to notes (never overwrite)
  const noteEntry = `[LinkedIn Import] ${signals.conversationSummary.slice(0, 200)}`;
  if (!node.notes || node.notes.trim() === "") {
    node.notes = noteEntry;
  } else if (!node.notes.includes("[LinkedIn Import]")) {
    node.notes = node.notes + "\n---\n" + noteEntry;
  }

  node.updatedAt = new Date().toISOString();

  return node;
}
