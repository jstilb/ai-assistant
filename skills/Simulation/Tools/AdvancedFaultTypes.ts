#!/usr/bin/env bun
/**
 * AdvancedFaultTypes.ts - Extended fault types beyond the original 4
 *
 * New fault types:
 *   - partial_response: Truncated or incomplete responses
 *   - delayed_response: Slow responses with configurable delay
 *   - intermittent_failure: Random success/failure pattern
 *   - data_corruption: Valid JSON but semantically wrong data
 *   - resource_exhaustion: Simulate OOM, disk full, connection pool exhaustion
 *
 * Each fault has configurable parameters and integrates with TriggerEngine.
 *
 * Usage:
 *   import { createAdvancedFaultEngine } from "./AdvancedFaultTypes.ts";
 *   const engine = createAdvancedFaultEngine({ seed: 42 });
 *   const result = engine.inject(fault, originalData);
 */

// ============================================
// TYPES
// ============================================

export type AdvancedFaultType =
  | "partial_response"
  | "delayed_response"
  | "intermittent_failure"
  | "data_corruption"
  | "resource_exhaustion";

export type CorruptionType = "missing_fields" | "wrong_types" | "null_values" | "extra_fields";
export type ResourceType = "memory" | "disk" | "connections";
export type IntermittentPattern = "random" | "alternating" | "burst";

export interface AdvancedFault {
  type: AdvancedFaultType;
  parameters: {
    // partial_response
    truncate_at?: number;
    // delayed_response
    delay_ms?: number;
    jitter_ms?: number;
    // intermittent_failure
    success_rate?: number;
    pattern?: IntermittentPattern;
    // data_corruption
    corruption_type?: CorruptionType;
    // resource_exhaustion
    resource?: ResourceType;
    error_message?: string;
  };
}

export interface AdvancedFaultResponse {
  type: AdvancedFaultType;
  data?: string;
  truncated?: boolean;
  delay_ms?: number;
  success?: boolean;
  error?: boolean;
  error_code?: string;
  error_message?: string;
  [key: string]: unknown;
}

export interface FaultGenerationOptions {
  seed?: number;
  callIndex?: number;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

interface AdvancedFaultEngineStats {
  totalInjections: number;
  byType: Record<string, number>;
}

// ============================================
// CONSTANTS
// ============================================

export const ADVANCED_FAULT_TYPES: readonly AdvancedFaultType[] = [
  "partial_response",
  "delayed_response",
  "intermittent_failure",
  "data_corruption",
  "resource_exhaustion",
] as const;

const VALID_CORRUPTION_TYPES: readonly CorruptionType[] = [
  "missing_fields",
  "wrong_types",
  "null_values",
  "extra_fields",
];

const VALID_RESOURCE_TYPES: readonly ResourceType[] = ["memory", "disk", "connections"];
const VALID_PATTERNS: readonly IntermittentPattern[] = ["random", "alternating", "burst"];

const DEFAULT_ERROR_MESSAGES: Record<ResourceType, string> = {
  memory: "JavaScript heap out of memory",
  disk: "ENOSPC: no space left on device",
  connections: "ECONNREFUSED: connection pool exhausted",
};

const ERROR_CODES: Record<ResourceType, string> = {
  memory: "OOM_KILLED",
  disk: "ENOSPC",
  connections: "CONN_POOL_EXHAUSTED",
};

// ============================================
// VALIDATION
// ============================================

/**
 * Validate an advanced fault configuration.
 */
export function validateAdvancedFault(fault: AdvancedFault): ValidationResult {
  const errors: string[] = [];

  if (!ADVANCED_FAULT_TYPES.includes(fault.type)) {
    errors.push(`Invalid fault type "${fault.type}". Valid: ${ADVANCED_FAULT_TYPES.join(", ")}`);
    return { valid: false, errors };
  }

  const params = fault.parameters;

  switch (fault.type) {
    case "partial_response":
      if (params.truncate_at !== undefined && params.truncate_at < 0) {
        errors.push("truncate_at must be >= 0");
      }
      break;

    case "delayed_response":
      if (params.delay_ms !== undefined && params.delay_ms < 0) {
        errors.push("delay_ms must be >= 0");
      }
      if (params.jitter_ms !== undefined && params.jitter_ms < 0) {
        errors.push("jitter_ms must be >= 0");
      }
      break;

    case "intermittent_failure":
      if (params.success_rate !== undefined && (params.success_rate < 0 || params.success_rate > 1)) {
        errors.push("success_rate must be between 0 and 1");
      }
      if (params.pattern !== undefined && !VALID_PATTERNS.includes(params.pattern)) {
        errors.push(`Invalid pattern "${params.pattern}". Valid: ${VALID_PATTERNS.join(", ")}`);
      }
      break;

    case "data_corruption":
      if (params.corruption_type !== undefined && !VALID_CORRUPTION_TYPES.includes(params.corruption_type)) {
        errors.push(`Invalid corruption_type "${params.corruption_type}". Valid: ${VALID_CORRUPTION_TYPES.join(", ")}`);
      }
      break;

    case "resource_exhaustion":
      if (params.resource !== undefined && !VALID_RESOURCE_TYPES.includes(params.resource)) {
        errors.push(`Invalid resource "${params.resource}". Valid: ${VALID_RESOURCE_TYPES.join(", ")}`);
      }
      break;
  }

  return { valid: errors.length === 0, errors };
}

// ============================================
// SEEDED RANDOM
// ============================================

function seededRandom(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

// ============================================
// FAULT RESPONSE GENERATION
// ============================================

/**
 * Generate a fault response for an advanced fault type.
 */
export function generateFaultResponse(
  fault: AdvancedFault,
  originalData: string,
  options: FaultGenerationOptions = {},
): AdvancedFaultResponse {
  const { seed = 42, callIndex = 0 } = options;

  switch (fault.type) {
    case "partial_response":
      return generatePartialResponse(fault, originalData);

    case "delayed_response":
      return generateDelayedResponse(fault, originalData, seed, callIndex);

    case "intermittent_failure":
      return generateIntermittentFailure(fault, originalData, seed, callIndex);

    case "data_corruption":
      return generateDataCorruption(fault, originalData, seed);

    case "resource_exhaustion":
      return generateResourceExhaustion(fault);

    default:
      return { type: fault.type, error: true, error_message: `Unknown fault type: ${fault.type}` };
  }
}

// --- Partial Response ---

function generatePartialResponse(
  fault: AdvancedFault,
  originalData: string,
): AdvancedFaultResponse {
  const truncateAt = fault.parameters.truncate_at ?? Math.floor(originalData.length / 2);
  const truncated = originalData.slice(0, truncateAt);

  return {
    type: "partial_response",
    data: truncated,
    truncated: true,
  };
}

// --- Delayed Response ---

function generateDelayedResponse(
  fault: AdvancedFault,
  _originalData: string,
  seed: number,
  callIndex: number,
): AdvancedFaultResponse {
  const baseDelay = fault.parameters.delay_ms ?? 1000;
  const jitter = fault.parameters.jitter_ms ?? 0;

  let actualDelay = baseDelay;
  if (jitter > 0) {
    const random = seededRandom(seed + callIndex);
    const jitterAmount = (random * 2 - 1) * jitter; // -jitter to +jitter
    actualDelay = Math.round(baseDelay + jitterAmount);
  }

  return {
    type: "delayed_response",
    delay_ms: actualDelay,
    data: _originalData,
  };
}

// --- Intermittent Failure ---

function generateIntermittentFailure(
  fault: AdvancedFault,
  _originalData: string,
  seed: number,
  callIndex: number,
): AdvancedFaultResponse {
  const successRate = fault.parameters.success_rate ?? 0.5;
  const pattern = fault.parameters.pattern ?? "random";

  let success: boolean;

  switch (pattern) {
    case "random": {
      const random = seededRandom(seed + callIndex);
      success = random < successRate;
      break;
    }
    case "alternating": {
      success = callIndex % 2 === 0;
      break;
    }
    case "burst": {
      // Burst pattern: 3 successes, 3 failures, repeat
      const burstSize = 3;
      const cyclePos = callIndex % (burstSize * 2);
      success = cyclePos < burstSize;
      break;
    }
    default:
      success = true;
  }

  if (success) {
    return {
      type: "intermittent_failure",
      success: true,
      data: _originalData,
    };
  } else {
    return {
      type: "intermittent_failure",
      success: false,
      error: true,
      error_code: "INTERMITTENT_FAILURE",
      error_message: "Intermittent failure occurred",
    };
  }
}

// --- Data Corruption ---

function generateDataCorruption(
  fault: AdvancedFault,
  originalData: string,
  seed: number,
): AdvancedFaultResponse {
  const corruptionType = fault.parameters.corruption_type ?? "missing_fields";

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(originalData);
  } catch {
    // If not valid JSON, just corrupt the string
    return {
      type: "data_corruption",
      data: originalData.slice(0, Math.floor(originalData.length / 2)),
    };
  }

  let corrupted: Record<string, unknown>;

  switch (corruptionType) {
    case "missing_fields": {
      // Remove approximately half the fields
      const keys = Object.keys(parsed);
      corrupted = {};
      for (let i = 0; i < keys.length; i++) {
        if (seededRandom(seed + i) > 0.5) {
          corrupted[keys[i]] = parsed[keys[i]];
        }
      }
      // Ensure at least one field is removed
      if (Object.keys(corrupted).length === keys.length && keys.length > 0) {
        delete corrupted[keys[0]];
      }
      break;
    }

    case "wrong_types": {
      // Change types: numbers become strings, strings become numbers, etc.
      corrupted = {};
      const keys = Object.keys(parsed);
      for (const key of keys) {
        const val = parsed[key];
        if (typeof val === "number") {
          corrupted[key] = String(val);
        } else if (typeof val === "string") {
          corrupted[key] = val.length;
        } else if (typeof val === "boolean") {
          corrupted[key] = val ? 1 : 0;
        } else {
          corrupted[key] = val;
        }
      }
      break;
    }

    case "null_values": {
      // Set some values to null
      corrupted = {};
      const keys = Object.keys(parsed);
      for (let i = 0; i < keys.length; i++) {
        if (seededRandom(seed + i) < 0.5) {
          corrupted[keys[i]] = null;
        } else {
          corrupted[keys[i]] = parsed[keys[i]];
        }
      }
      // Ensure at least one null
      if (!Object.values(corrupted).some(v => v === null) && keys.length > 0) {
        corrupted[keys[0]] = null;
      }
      break;
    }

    case "extra_fields": {
      // Add unexpected fields
      corrupted = { ...parsed };
      corrupted["_corrupted_field_1"] = "unexpected_data";
      corrupted["_corrupted_field_2"] = Math.floor(seededRandom(seed) * 9999);
      corrupted["__metadata"] = { corruption: true, seed };
      break;
    }

    default:
      corrupted = { ...parsed };
  }

  return {
    type: "data_corruption",
    data: JSON.stringify(corrupted),
  };
}

// --- Resource Exhaustion ---

function generateResourceExhaustion(fault: AdvancedFault): AdvancedFaultResponse {
  const resource = fault.parameters.resource ?? "memory";
  const errorMessage = fault.parameters.error_message ?? DEFAULT_ERROR_MESSAGES[resource as ResourceType] ?? "Resource exhausted";
  const errorCode = ERROR_CODES[resource as ResourceType] ?? "RESOURCE_EXHAUSTED";

  return {
    type: "resource_exhaustion",
    error: true,
    error_code: errorCode,
    error_message: errorMessage,
  };
}

// ============================================
// ENGINE
// ============================================

export interface AdvancedFaultEngine {
  inject(fault: AdvancedFault, originalData: string): AdvancedFaultResponse;
  getStats(): AdvancedFaultEngineStats;
  reset(): void;
}

/**
 * Create an advanced fault engine with a seed for deterministic behavior.
 */
export function createAdvancedFaultEngine(options: { seed: number }): AdvancedFaultEngine {
  let injectionCount = 0;
  const typeCount: Record<string, number> = {};
  const seed = options.seed;

  return {
    inject(fault: AdvancedFault, originalData: string): AdvancedFaultResponse {
      const validation = validateAdvancedFault(fault);
      if (!validation.valid) {
        throw new Error(`Invalid fault config: ${validation.errors.join(", ")}`);
      }

      const callIndex = injectionCount;
      injectionCount++;
      typeCount[fault.type] = (typeCount[fault.type] || 0) + 1;

      return generateFaultResponse(fault, originalData, { seed, callIndex });
    },

    getStats(): AdvancedFaultEngineStats {
      return {
        totalInjections: injectionCount,
        byType: { ...typeCount },
      };
    },

    reset(): void {
      injectionCount = 0;
      for (const key of Object.keys(typeCount)) {
        delete typeCount[key];
      }
    },
  };
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "inject": {
      const configPath = args[0];
      const dataPath = args[1];
      if (!configPath) {
        console.error("Usage: inject <fault-config.json> [data-file]");
        process.exit(1);
      }
      const { readFileSync } = await import("fs");
      const fault: AdvancedFault = JSON.parse(readFileSync(configPath, "utf-8"));
      const data = dataPath ? readFileSync(dataPath, "utf-8") : '{"test": true}';

      const validation = validateAdvancedFault(fault);
      if (!validation.valid) {
        console.error("Invalid fault:", validation.errors.join(", "));
        process.exit(1);
      }

      const result = generateFaultResponse(fault, data);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case "validate": {
      const configPath = args[0];
      if (!configPath) {
        console.error("Usage: validate <fault-config.json>");
        process.exit(1);
      }
      const { readFileSync } = await import("fs");
      const fault: AdvancedFault = JSON.parse(readFileSync(configPath, "utf-8"));
      const result = validateAdvancedFault(fault);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.valid ? 0 : 1);
      break;
    }

    case "types": {
      console.log(JSON.stringify(ADVANCED_FAULT_TYPES, null, 2));
      break;
    }

    default:
      console.log(`AdvancedFaultTypes - Extended fault type injection

Commands:
  inject <config.json> [data-file]   Inject an advanced fault
  validate <config.json>             Validate fault configuration
  types                              List all advanced fault types

Fault types: ${ADVANCED_FAULT_TYPES.join(", ")}`);
      break;
  }
}
