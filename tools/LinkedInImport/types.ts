// LinkedIn Import Pipeline — All TypeScript Interfaces
// Strict mode, no 'any'

// ===== RAW CSV ROW TYPES =====

export interface MessageRow {
  "CONVERSATION ID": string;
  "CONVERSATION TITLE": string;
  FROM: string;
  "SENDER PROFILE URL": string;
  TO: string;
  "RECIPIENT PROFILE URLS": string;
  DATE: string;
  SUBJECT: string;
  CONTENT: string;
  FOLDER: string;
  ATTACHMENTS: string;
  "IS MESSAGE DRAFT": string;
}

export interface EndorsementReceivedRow {
  "Endorsement Date": string;
  "Skill Name": string;
  "Endorser First Name": string;
  "Endorser Last Name": string;
  "Endorser Public Url": string;
  "Endorsement Status": string;
}

export interface EndorsementGivenRow {
  "Endorsement Date": string;
  "Skill Name": string;
  "Endorsee First Name": string;
  "Endorsee Last Name": string;
  "Endorsee Public Url": string;
  "Endorsement Status": string;
}

export interface RecommendationRow {
  "First Name": string;
  "Last Name": string;
  Company: string;
  "Job Title": string;
  Text: string;
  "Creation Date": string;
  Status: string;
}

export interface JobApplicationRow {
  "Application Date": string;
  "Contact Email": string;
  "Contact Phone Number": string;
  "Company Name": string;
  "Job Title": string;
  "Job Url": string;
  "Resume Name": string;
  "Question And Answers": string;
}

export interface SavedAnswerRow {
  Question: string;
  Answer: string;
}

// ===== PARSED / DOMAIN TYPES =====

export type ConversationType =
  | "genuine_relationship"
  | "recruiter_inbound"
  | "spam"
  | "professional_inquiry";

export type RelationshipStrength = "strong" | "moderate" | "weak" | "dormant";

export interface ParsedMessage {
  conversationId: string;
  conversationTitle: string;
  from: string;
  senderUrl: string;
  to: string;
  recipientUrls: string[];
  date: Date;
  content: string; // HTML stripped
  isFromJm: boolean;
}

export interface ConversationData {
  conversationId: string;
  conversationTitle: string;
  messages: ParsedMessage[];
  participants: string[]; // normalized URLs of non-Jm participants
  messageCount: number;
  jmMessageCount: number;
  otherMessageCount: number;
  bidirectional: boolean;
  latestDate: Date;
  earliestDate: Date;
  plainTextContent: string; // combined stripped content for classification
}

export interface ConversationSignals {
  conversationId: string;
  participantUrl: string;
  nodeId: string;
  conversationType: ConversationType;
  totalMessages: number;
  bidirectional: boolean;
  lastContact: Date;
  lastMessageFrom: "jm" | "contact";
  layoffSupport: boolean;
  conversationSummary: string;
  strengthUpgrade: RelationshipStrength | null;
}

// ===== ENRICHMENT OUTPUT TYPES =====

export interface MessageIntelligence {
  totalMessages: number;
  bidirectional: boolean;
  conversationType: ConversationType;
  lastMessageDate: string; // ISO8601
  lastMessageFrom: "jm" | "contact";
  conversationSummary: string;
}

export interface EndorsementRecord {
  skillName: string;
  date: string;
}

export interface NodeEndorsements {
  received: EndorsementRecord[];
  given: EndorsementRecord[];
  isRecommender: boolean;
  isChampion: boolean;
}

// ===== NETWORK GRAPH NODE TYPES =====

export interface NetworkNode {
  id: string;
  name: string;
  linkedinUrl: string;
  relationship: {
    type: string;
    sharedContext: string;
    strength: RelationshipStrength;
    lastContact: string | null;
  };
  professional: {
    currentCompany: string;
    currentRole: string;
    previousCompanies: string[];
    skills: string[];
  };
  outreach: {
    status: string;
    messagesSent: unknown[];
    messagesReceived: unknown[];
    nextAction: string | null;
    nextActionDate: string | null;
    declinedAt: string | null;
  };
  enrichedAt: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
  // Optional enrichment fields (added by this pipeline)
  messageIntelligence?: MessageIntelligence;
  endorsements?: NodeEndorsements;
}

export interface NetworkGraph {
  nodes: NetworkNode[];
  edges?: unknown[];
}

// ===== JOBBLITZ APPLICATION TYPE =====

export interface LinkedInHistoricalApplication {
  application_id: string;
  timestamp: string;
  job: {
    title: string;
    company: string;
    url: string;
  };
  source: "linkedin_historical";
  status: "submitted";
  submission_method: "linkedin_easy_apply";
  dedup_hash: string;
  response_received: false;
  response_date: null;
  imported_at: string;
}

// ===== TESTIMONIAL TYPES =====

export interface TestimonialQuote {
  text: string;
  themes: string[];
}

export interface Testimonial {
  attribution: {
    firstName: string;
    lastName: string;
    role: string;
    company: string;
    date: string;
  };
  quotes: TestimonialQuote[];
  fullText: string;
}

export interface TestimonialsFile {
  testimonials: Testimonial[];
}

// ===== QUESTION BANK =====

export interface QuestionAnswer {
  question: string;
  answer: string;
  source: "linkedin_saved";
}

export interface QuestionBank {
  screening_questions: QuestionAnswer[];
}

// ===== RESULT TYPE =====

export type Result<T, E = Error> =
  | { success: true; data: T }
  | { success: false; error: E };

// ===== PIPELINE STATS =====

export interface PipelineStats {
  feature1: {
    totalMessages: number;
    totalConversations: number;
    matchedConversations: number;
    matchRate: number;
    updatedNodes: number;
    strengthUpgrades: {
      toStrong: number;
      toModerate: number;
      toWeak: number;
    };
    layoffSupportNodes: number;
  };
  feature2: {
    endorsementsReceived: number;
    endorsementsGiven: number;
    matchedEndorsers: number;
    recommenders: number;
    champions: number;
    strengthUpgrades: number;
  };
  feature3: {
    totalApplicationsParsed: number;
    newApplicationsImported: number;
    duplicatesSkipped: number;
    questionAnswerPairs: number;
  };
  feature4: {
    recommendationsProcessed: number;
    quotesExtracted: number;
    themes: string[];
  };
}
