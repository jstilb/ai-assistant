/**
 * CanvasTemplate — Phase 3: Templates (Layout Reuse)
 *
 * Canonical type definitions for the Canvas template system.
 * These types are shared between TemplateManager.ts and CanvasClient.ts.
 * The browser-side protocol.ts mirrors these types.
 *
 * @module CanvasTemplate
 * @version 1.0.0
 */

// ============================================================================
// Grid Position (mirrors ContainerSpec.position from Phase 1)
// ============================================================================

export interface GridPosition {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ============================================================================
// Template Variable
// ============================================================================

export interface TemplateVariable {
  /** Used as $name in template content, e.g. "projectDir" → $projectDir */
  name: string;
  /** Human-readable label shown in the form dialog */
  label: string;
  type: 'string' | 'path' | 'url' | 'number';
  default?: string;
  placeholder?: string;
  required: boolean;
}

// ============================================================================
// Template Container
// ============================================================================

export interface TemplateContainer {
  /** May contain $variable references */
  title: string;
  type: string;
  position: GridPosition;
  /** String values within content may contain $variable references */
  content: Record<string, unknown>;
  /** Index into CanvasTemplate.tabGroups — undefined if not in a group */
  tabGroupIndex?: number;
}

// ============================================================================
// Template Tab Group
// ============================================================================

export interface TemplateTabGroup {
  /** Indices into CanvasTemplate.containers */
  containerIndices: number[];
  /** Index of the default active container within containerIndices */
  activeIndex: number;
}

// ============================================================================
// Canvas Template
// ============================================================================

export interface CanvasTemplate {
  id: string;
  name: string;
  description?: string;
  tags: string[];
  /** 'system' = read-only (from Config/templates/); 'user' = editable (from IndexedDB) */
  source: 'system' | 'user';
  variables: TemplateVariable[];
  /** SVG string for layout preview thumbnail */
  thumbnail?: string;
  createdAt: string;
  updatedAt: string;
  containers: TemplateContainer[];
  tabGroups: TemplateTabGroup[];
}

// ============================================================================
// Apply Result
// ============================================================================

export interface TemplateApplyResult {
  sheetId: string;
  containerIds: string[];
}
