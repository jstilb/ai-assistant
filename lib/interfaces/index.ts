/**
 * lib/interfaces/index.ts — Barrel re-export of all public types.
 *
 * Usage:
 *   import { SkillConfig, TraceEvent } from 'lib/interfaces';
 */

// Skills
export type {
  SkillConfig,
  SkillMapEntry,
  SkillMap,
  SkillInvocationParams,
  SkillInvocationResult,
} from './Skills';

// Monitoring
export type {
  TraceEvent,
  AnomalyRecord,
  AlertEntry,
  PipelineLockState,
} from './Monitoring';

// Notifications
export type {
  VoiceNotificationPayload,
  NotificationQueueItem,
} from './Notifications';
