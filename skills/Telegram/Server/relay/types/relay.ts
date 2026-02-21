/**
 * relay.ts - Re-export relay types for desktop relay client
 *
 * These are the same types as kaya-relay/src/types/relay.ts
 * kept in sync manually (or via a shared package in production).
 */

export type FrameType =
  | "message"
  | "voice_chunk"
  | "media_upload"
  | "ack"
  | "ping"
  | "pong"
  | "response"
  | "notification"
  | "status"
  | "interrupt"
  | "pair_request"
  | "pair_response"
  | "pair_confirm";

export interface RelayFrame {
  type: FrameType;
  id: string;
  encrypted: string;
  nonce: string;
  timestamp: number;
}

export interface MessagePayload {
  text: string;
  mediaRef?: string;
  mediaType?: "image" | "video" | "document";
  caption?: string;
  sessionId: string;
  replyToId?: string;
}

export interface VoiceChunkPayload {
  audio: string;
  sampleRate: number;
  isFirst: boolean;
  isLast: boolean;
  sessionId: string;
}

export interface ResponsePayload {
  text: string;
  voiceRef?: string;
  sessionId: string;
  metadata: {
    contextProfile: string;
    responseTimeMs: number;
    source: "relay";
  };
}

export interface NotificationPayload {
  title: string;
  body: string;
  category: "briefing" | "reminder" | "alert" | "cron_result";
  actionUrl?: string;
}

export interface StatusPayload {
  code:
    | "processing"
    | "voice_started"
    | "voice_stopped"
    | "interrupted"
    | "error";
  message?: string;
  sessionId?: string;
}
