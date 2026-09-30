/**
 * Notifications.ts — Shared types for voice notifications.
 *
 * Note: NotificationQueueItem here is the INTERNAL retry queue type from
 * NotificationService.ts — renamed from QueueItem to avoid confusion with
 * the QueueRouter's QueueItem type in Queue.ts.
 *
 * Usage:
 *   import { VoiceNotificationPayload, NotificationQueueItem } from 'lib/interfaces/Notifications';
 */

export interface VoiceNotificationPayload {
  message: string;
  context?: string;
  priority?: 'low' | 'normal' | 'high';
  voiceId?: string;
  title?: string;
}

export interface NotificationQueueItem {
  id: string;
  message: string;
  options?: Omit<VoiceNotificationPayload, 'message'>;
  attempts: number;
  firstAttemptAt: string;
  lastAttemptAt?: string;
  status: 'pending' | 'sent' | 'failed';
}
