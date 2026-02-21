/**
 * JSON Schema Check Grader
 * Validate JSON structure against schema
 */

import { BaseGrader, registerGrader, type GraderContext } from '../Base.ts';
import type { GraderConfig, GraderResult } from '../../Types/index.ts';
import { z, type ZodSchema, type ZodError } from 'zod';

export interface JsonSchemaCheckParams {
  // Zod schema as JSON representation
  schema?: {
    type: 'object' | 'array' | 'string' | 'number' | 'boolean';
    properties?: Record<string, unknown>;
    required?: string[];
    items?: unknown;
  };

  // Simple field requirements (alternative to full schema)
  required_fields?: string[];
  optional_fields?: string[];
  forbidden_fields?: string[];

  // Type checks
  field_types?: Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>;

  // Extract JSON from output (in case it's embedded in text)
  extract_json?: boolean;

  // Strict mode: no extra fields allowed
  strict?: boolean;
}

export class JsonSchemaCheckGrader extends BaseGrader {
  type = 'json_schema' as const;
  category = 'code_based' as const;

  async grade(context: GraderContext): Promise<GraderResult> {
    const start = performance.now();
    const params = this.config.params as JsonSchemaCheckParams;

    const checks: { check: string; passed: boolean; detail: string }[] = [];

    // Extract JSON from output
    let jsonData: unknown;
    try {
      if (params.extract_json) {
        // Try to find JSON in markdown code blocks first
        const codeBlockMatch = context.output.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
        if (codeBlockMatch) {
          jsonData = JSON.parse(codeBlockMatch[1]);
        } else {
          // Try to find any JSON object or array
          const jsonMatch = context.output.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
          if (jsonMatch) {
            jsonData = JSON.parse(jsonMatch[1]);
          } else {
            throw new Error('No JSON found in output');
          }
        }
      } else {
        jsonData = JSON.parse(context.output);
      }
    } catch (error) {
      return this.createResult(0, false, performance.now() - start, {
        reasoning: `JSON parsing failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    if (typeof jsonData !== 'object' || jsonData === null) {
      return this.createResult(0, false, performance.now() - start, {
        reasoning: 'Output is not a valid JSON object or array',
      });
    }

    const dataObj = jsonData as Record<string, unknown>;

    // Check required fields
    if (params.required_fields) {
      for (const field of params.required_fields) {
        const exists = field in dataObj;
        checks.push({
          check: `required_field: ${field}`,
          passed: exists,
          detail: exists ? 'present' : 'missing',
        });
      }
    }

    // Check forbidden fields
    if (params.forbidden_fields) {
      for (const field of params.forbidden_fields) {
        const exists = field in dataObj;
        checks.push({
          check: `forbidden_field: ${field}`,
          passed: !exists,
          detail: !exists ? 'correctly absent' : 'present (should not be)',
        });
      }
    }

    // Check field types
    if (params.field_types) {
      for (const [field, expectedType] of Object.entries(params.field_types)) {
        if (!(field in dataObj)) {
          checks.push({
            check: `field_type: ${field}`,
            passed: false,
            detail: 'field missing',
          });
          continue;
        }

        const value = dataObj[field];
        const actualType = Array.isArray(value) ? 'array' : typeof value;
        const passed = actualType === expectedType;

        checks.push({
          check: `field_type: ${field}`,
          passed,
          detail: passed ? `${expectedType}` : `expected ${expectedType}, got ${actualType}`,
        });
      }
    }

    // Strict mode: check for extra fields
    if (params.strict) {
      const allowedFields = new Set([
        ...(params.required_fields ?? []),
        ...(params.optional_fields ?? []),
        ...Object.keys(params.field_types ?? {}),
      ]);

      for (const field of Object.keys(dataObj)) {
        if (!allowedFields.has(field)) {
          checks.push({
            check: `strict_mode: ${field}`,
            passed: false,
            detail: 'unexpected field in strict mode',
          });
        }
      }
    }

    // Full schema validation (if provided)
    if (params.schema) {
      try {
        const zodSchema = this.buildZodSchema(params.schema);
        const result = zodSchema.safeParse(jsonData);

        if (result.success) {
          checks.push({
            check: 'schema_validation',
            passed: true,
            detail: 'schema validation passed',
          });
        } else {
          const errors = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
          checks.push({
            check: 'schema_validation',
            passed: false,
            detail: `validation errors: ${errors.join(', ')}`,
          });
        }
      } catch (error) {
        checks.push({
          check: 'schema_validation',
          passed: false,
          detail: `schema build error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    const passCount = checks.filter(c => c.passed).length;
    const score = checks.length > 0 ? passCount / checks.length : 1;
    const passed = score === 1.0; // All checks must pass for schema validation

    return this.createResult(score, passed, performance.now() - start, {
      reasoning: `${passCount}/${checks.length} JSON schema checks passed`,
      details: {
        checks,
        parsed_json: jsonData,
      },
    });
  }

  private buildZodSchema(schema: JsonSchemaCheckParams['schema']): ZodSchema {
    if (!schema) {
      throw new Error('No schema provided');
    }

    switch (schema.type) {
      case 'object':
        if (schema.properties) {
          const shape: Record<string, ZodSchema> = {};
          for (const [key, propSchema] of Object.entries(schema.properties)) {
            // Simplified: assume basic types for now
            if (typeof propSchema === 'object' && propSchema !== null && 'type' in propSchema) {
              const type = (propSchema as { type: string }).type;
              switch (type) {
                case 'string':
                  shape[key] = z.string();
                  break;
                case 'number':
                  shape[key] = z.number();
                  break;
                case 'boolean':
                  shape[key] = z.boolean();
                  break;
                default:
                  shape[key] = z.unknown();
              }
            } else {
              shape[key] = z.unknown();
            }
          }

          let objectSchema = z.object(shape);

          // Make fields optional if not in required array
          if (schema.required) {
            const requiredSet = new Set(schema.required);
            const partialShape: Record<string, ZodSchema> = {};
            for (const [key, zodType] of Object.entries(shape)) {
              partialShape[key] = requiredSet.has(key) ? zodType : zodType.optional();
            }
            objectSchema = z.object(partialShape);
          }

          return objectSchema;
        }
        return z.object({});

      case 'array':
        return z.array(z.unknown());

      case 'string':
        return z.string();

      case 'number':
        return z.number();

      case 'boolean':
        return z.boolean();

      default:
        return z.unknown();
    }
  }
}

registerGrader('json_schema', JsonSchemaCheckGrader);
