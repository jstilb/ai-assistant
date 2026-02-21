#!/usr/bin/env bun
/**
 * Google Sheets CLI - Unix-style interface for Google Sheets operations
 *
 * Phase 1 - Essential Data Operations:
 *   kaya-cli sheets list                      - List recent spreadsheets
 *   kaya-cli sheets create <name>             - Create new spreadsheet
 *   kaya-cli sheets read <id> [range]         - Read data from sheet
 *   kaya-cli sheets write <id> <range> <json> - Write data to sheet
 *   kaya-cli sheets append <id> <json>        - Append rows to sheet
 *   kaya-cli sheets clear <id> <range>        - Clear range without deleting
 *   kaya-cli sheets delete-rows <id> <sheet> 5:10 - Delete specific rows
 *   kaya-cli sheets import <id> [sheet] < data.csv - Import CSV/TSV
 *   kaya-cli sheets export <id> [range] --csv - Export to CSV/TSV
 *   kaya-cli sheets batch <id> <json-ops>     - Batch operations
 *   kaya-cli sheets info <id>                 - Get spreadsheet metadata
 *   kaya-cli sheets format <id> <range>       - Apply cell formatting
 *   kaya-cli sheets freeze <id> <sheet>       - Freeze rows/columns
 *   kaya-cli sheets share <id> <email>        - Share spreadsheet
 *   kaya-cli sheets permissions <id>          - List permissions
 *   kaya-cli sheets protect <id> <range>      - Protect a range
 *
 * Phase 2 - Sheet/Tab Management:
 *   kaya-cli sheets add-sheet <id> <name>     - Create new tab
 *   kaya-cli sheets delete-sheet <id> <name>  - Remove tab
 *   kaya-cli sheets rename-sheet <id> <old> <new> - Rename tab
 *   kaya-cli sheets copy-sheet <id> <name> [--to <dest_id>] - Copy tab
 *   kaya-cli sheets duplicate <id> [name]     - Clone entire spreadsheet
 *
 * Phase 3 - Data Intelligence:
 *   kaya-cli sheets find <id> "term"          - Search for values
 *   kaya-cli sheets sort <id> <range> --by=B  - Sort range by column
 *   kaya-cli sheets filter <id> <range> --col=B --gt=100 - Filter rows
 *   kaya-cli sheets formula <id> <cell> <formula> - Set formula
 *   kaya-cli sheets named-ranges <id> list    - List named ranges
 *   kaya-cli sheets named-ranges <id> add <name> <range> - Add named range
 *   kaya-cli sheets named-ranges <id> delete <name> - Delete named range
 */

import { google } from 'googleapis';
import { homedir } from 'os';
import { existsSync, readFileSync } from 'fs';
import { z } from 'zod';
import { createStateManager } from '../../CORE/Tools/StateManager';
import { maybeEncode } from '../../CORE/Tools/ToonHelper';

const COLORS = {
  red: '\x1b[0;31m',
  green: '\x1b[0;32m',
  yellow: '\x1b[1;33m',
  blue: '\x1b[0;34m',
  cyan: '\x1b[0;36m',
  nc: '\x1b[0m'
};

// Auth configuration
const CREDENTIALS_PATH = `${homedir()}/.config/google/credentials.json`;
const TOKEN_PATH = `${homedir()}/.config/google/sheets-token.json`;

/**
 * Parse hex color (#RRGGBB or #RGB) to Google Sheets RGB format (0-1 range)
 */
function parseHexColor(hex: string): { red: number; green: number; blue: number } {
  let cleanHex = hex.replace('#', '');

  // Expand shorthand (#RGB -> #RRGGBB)
  if (cleanHex.length === 3) {
    cleanHex = cleanHex.split('').map(c => c + c).join('');
  }

  const r = parseInt(cleanHex.substring(0, 2), 16) / 255;
  const g = parseInt(cleanHex.substring(2, 4), 16) / 255;
  const b = parseInt(cleanHex.substring(4, 6), 16) / 255;

  return { red: r, green: g, blue: b };
}

/**
 * Parse A1 notation range to grid coordinates
 * Returns { sheetId, startRowIndex, endRowIndex, startColumnIndex, endColumnIndex }
 */
function parseA1Range(range: string): {
  sheetName?: string;
  startColumnIndex: number;
  endColumnIndex: number;
  startRowIndex: number;
  endRowIndex: number;
} {
  // Handle "Sheet1!A1:B10" or just "A1:B10"
  let sheetName: string | undefined;
  let cellRange = range;

  if (range.includes('!')) {
    const parts = range.split('!');
    sheetName = parts[0];
    cellRange = parts[1];
  }

  // Parse "A1:B10" or "A1"
  const rangeMatch = cellRange.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i);
  if (!rangeMatch) {
    throw new Error(`Invalid range format: ${range}`);
  }

  const startCol = columnToIndex(rangeMatch[1]);
  const startRow = parseInt(rangeMatch[2]) - 1; // 0-indexed
  const endCol = rangeMatch[3] ? columnToIndex(rangeMatch[3]) + 1 : startCol + 1;
  const endRow = rangeMatch[4] ? parseInt(rangeMatch[4]) : startRow + 1;

  return {
    sheetName,
    startColumnIndex: startCol,
    endColumnIndex: endCol,
    startRowIndex: startRow,
    endRowIndex: endRow
  };
}

/**
 * Convert column letter(s) to 0-indexed number (A=0, B=1, Z=25, AA=26)
 */
function columnToIndex(col: string): number {
  let index = 0;
  for (let i = 0; i < col.length; i++) {
    index = index * 26 + (col.charCodeAt(i) - 'A'.charCodeAt(0) + 1);
  }
  return index - 1;
}

/**
 * Get sheet ID by name from a spreadsheet
 */
async function getSheetId(spreadsheetId: string, sheetName: string): Promise<number> {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = meta.data.sheets?.find(s => s.properties?.title === sheetName);

  if (!sheet?.properties?.sheetId) {
    throw new Error(`Sheet "${sheetName}" not found`);
  }

  return sheet.properties.sheetId;
}

// Schema for Google OAuth credentials
const GoogleCredentialsSchema = z.object({
  installed: z.object({
    client_id: z.string(),
    client_secret: z.string(),
    redirect_uris: z.array(z.string()),
  }).optional(),
  web: z.object({
    client_id: z.string(),
    client_secret: z.string(),
    redirect_uris: z.array(z.string()),
  }).optional(),
}).passthrough();

const GoogleTokenSchema = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  token_type: z.string().optional(),
  expiry_date: z.number().optional(),
}).passthrough();

async function getAuthClient() {
  const credentialsManager = createStateManager({
    path: CREDENTIALS_PATH,
    schema: GoogleCredentialsSchema,
    defaults: {},
  });

  if (!(await credentialsManager.exists())) {
    console.error(`${COLORS.red}Error:${COLORS.nc} Google credentials not found at ${CREDENTIALS_PATH}`);
    console.error(`Run: bash ~/.claude/skills/UnixCLI/Tools/configure-google-auth.sh`);
    process.exit(1);
  }

  const credentials = await credentialsManager.load();
  const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web || { client_id: '', client_secret: '', redirect_uris: [] };

  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  const tokenManager = createStateManager({
    path: TOKEN_PATH,
    schema: GoogleTokenSchema,
    defaults: {},
  });

  if (await tokenManager.exists()) {
    const token = await tokenManager.load();
    oauth2Client.setCredentials(token);
    return oauth2Client;
  }

  // Need to authenticate
  console.error(`${COLORS.yellow}Authentication required.${COLORS.nc}`);
  console.error(`Run: bash ~/.claude/skills/UnixCLI/Tools/configure-google-auth.sh`);
  process.exit(1);
}

async function listSpreadsheets(limit = 10) {
  const auth = await getAuthClient();
  const drive = google.drive({ version: 'v3', auth });

  const response = await drive.files.list({
    q: "mimeType='application/vnd.google-apps.spreadsheet'",
    pageSize: limit,
    fields: 'files(id, name, modifiedTime)',
    orderBy: 'modifiedTime desc'
  });

  return response.data.files || [];
}

async function readSheet(spreadsheetId: string, range?: string) {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  if (!range) {
    // Get first sheet name
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const firstSheet = meta.data.sheets?.[0]?.properties?.title || 'Sheet1';
    range = firstSheet;
  }

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range
  });

  return response.data.values || [];
}

async function writeSheet(spreadsheetId: string, range: string, values: any[][]) {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values }
  });

  return response.data;
}

async function appendToSheet(spreadsheetId: string, values: any[][], sheetName?: string) {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  if (!sheetName) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    sheetName = meta.data.sheets?.[0]?.properties?.title || 'Sheet1';
  }

  const response = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: sheetName,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values }
  });

  return response.data;
}

async function getSheetInfo(spreadsheetId: string) {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.get({ spreadsheetId });

  return {
    title: response.data.properties?.title,
    locale: response.data.properties?.locale,
    sheets: response.data.sheets?.map(s => ({
      title: s.properties?.title,
      index: s.properties?.index,
      rows: s.properties?.gridProperties?.rowCount,
      cols: s.properties?.gridProperties?.columnCount
    }))
  };
}

/**
 * Apply formatting to a range of cells
 */
async function formatRange(
  spreadsheetId: string,
  range: string,
  options: {
    bold?: boolean;
    italic?: boolean;
    bgColor?: string;
    fgColor?: string;
    align?: 'left' | 'center' | 'right';
  }
) {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const parsed = parseA1Range(range);
  const sheetName = parsed.sheetName || 'Sheet1';
  const sheetId = await getSheetId(spreadsheetId, sheetName);

  // Build cell format
  const cellFormat: any = {};
  const fields: string[] = [];

  // Text formatting
  if (options.bold !== undefined || options.italic !== undefined || options.fgColor) {
    cellFormat.textFormat = {};
    if (options.bold !== undefined) {
      cellFormat.textFormat.bold = options.bold;
      fields.push('userEnteredFormat.textFormat.bold');
    }
    if (options.italic !== undefined) {
      cellFormat.textFormat.italic = options.italic;
      fields.push('userEnteredFormat.textFormat.italic');
    }
    if (options.fgColor) {
      cellFormat.textFormat.foregroundColor = parseHexColor(options.fgColor);
      fields.push('userEnteredFormat.textFormat.foregroundColor');
    }
  }

  // Background color
  if (options.bgColor) {
    cellFormat.backgroundColor = parseHexColor(options.bgColor);
    fields.push('userEnteredFormat.backgroundColor');
  }

  // Horizontal alignment
  if (options.align) {
    const alignMap = { left: 'LEFT', center: 'CENTER', right: 'RIGHT' };
    cellFormat.horizontalAlignment = alignMap[options.align];
    fields.push('userEnteredFormat.horizontalAlignment');
  }

  const response = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: parsed.startRowIndex,
            endRowIndex: parsed.endRowIndex,
            startColumnIndex: parsed.startColumnIndex,
            endColumnIndex: parsed.endColumnIndex
          },
          cell: { userEnteredFormat: cellFormat },
          fields: fields.join(',')
        }
      }]
    }
  });

  return {
    success: true,
    range,
    appliedFormats: Object.keys(options).filter(k => options[k as keyof typeof options] !== undefined)
  };
}

/**
 * Freeze rows and/or columns in a sheet
 */
async function freezeRowsCols(
  spreadsheetId: string,
  sheetName: string,
  options: { rows?: number; cols?: number }
) {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const sheetId = await getSheetId(spreadsheetId, sheetName);

  const gridProperties: any = {};
  const fields: string[] = [];

  if (options.rows !== undefined) {
    gridProperties.frozenRowCount = options.rows;
    fields.push('frozenRowCount');
  }
  if (options.cols !== undefined) {
    gridProperties.frozenColumnCount = options.cols;
    fields.push('frozenColumnCount');
  }

  const response = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        updateSheetProperties: {
          properties: {
            sheetId,
            gridProperties
          },
          fields: `gridProperties(${fields.join(',')})`
        }
      }]
    }
  });

  return {
    success: true,
    sheet: sheetName,
    frozenRows: options.rows,
    frozenCols: options.cols
  };
}

/**
 * Share a spreadsheet with a user
 */
async function shareSpreadsheet(
  spreadsheetId: string,
  email: string,
  role: 'reader' | 'writer' | 'commenter'
) {
  const auth = await getAuthClient();
  const drive = google.drive({ version: 'v3', auth });

  // Map CLI role names to Drive API roles
  const roleMap = {
    reader: 'reader',
    writer: 'writer',
    commenter: 'commenter'
  };

  const response = await drive.permissions.create({
    fileId: spreadsheetId,
    requestBody: {
      type: 'user',
      role: roleMap[role],
      emailAddress: email
    },
    sendNotificationEmail: true
  });

  return {
    success: true,
    email,
    role,
    permissionId: response.data.id
  };
}

/**
 * List permissions for a spreadsheet
 */
async function listPermissions(spreadsheetId: string) {
  const auth = await getAuthClient();
  const drive = google.drive({ version: 'v3', auth });

  const response = await drive.permissions.list({
    fileId: spreadsheetId,
    fields: 'permissions(id, type, role, emailAddress, displayName)'
  });

  return response.data.permissions || [];
}

/**
 * Protect a range in a spreadsheet
 */
async function protectRange(
  spreadsheetId: string,
  range: string,
  description?: string
) {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const parsed = parseA1Range(range);
  const sheetName = parsed.sheetName || 'Sheet1';
  const sheetId = await getSheetId(spreadsheetId, sheetName);

  const response = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        addProtectedRange: {
          protectedRange: {
            range: {
              sheetId,
              startRowIndex: parsed.startRowIndex,
              endRowIndex: parsed.endRowIndex,
              startColumnIndex: parsed.startColumnIndex,
              endColumnIndex: parsed.endColumnIndex
            },
            description: description || `Protected range: ${range}`,
            warningOnly: false
          }
        }
      }]
    }
  });

  const protectedRangeId = response.data.replies?.[0]?.addProtectedRange?.protectedRange?.protectedRangeId;

  return {
    success: true,
    range,
    description: description || `Protected range: ${range}`,
    protectedRangeId
  };
}

// ============================================================================
// Phase 1 Essential: create, clear, delete-rows, import, export, batch
// ============================================================================

/**
 * Create a new spreadsheet
 */
async function createSpreadsheet(title: string) {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title }
    }
  });

  return {
    spreadsheetId: response.data.spreadsheetId,
    title: response.data.properties?.title,
    url: response.data.spreadsheetUrl
  };
}

/**
 * Clear a range without deleting the cells
 */
async function clearRange(spreadsheetId: string, range: string) {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range
  });

  return {
    clearedRange: response.data.clearedRange,
    spreadsheetId: response.data.spreadsheetId
  };
}

/**
 * Delete specific rows from a sheet
 */
async function deleteRows(spreadsheetId: string, sheetName: string, startRow: number, endRow: number) {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const sheetId = await getSheetId(spreadsheetId, sheetName);

  const response = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId,
            dimension: 'ROWS',
            startIndex: startRow - 1,  // 0-indexed
            endIndex: endRow           // exclusive
          }
        }
      }]
    }
  });

  return {
    deletedRows: endRow - startRow + 1,
    spreadsheetId: response.data.spreadsheetId
  };
}

/**
 * Import CSV/TSV data into a sheet
 */
async function importData(spreadsheetId: string, data: string, sheetName?: string, delimiter = ',') {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  if (!sheetName) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    sheetName = meta.data.sheets?.[0]?.properties?.title || 'Sheet1';
  }

  // Parse CSV/TSV data with proper quote handling
  const rows = data.trim().split('\n').map(line => {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++; // Skip escaped quote
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === delimiter && !inQuotes) {
        values.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current);
    return values;
  });

  const response = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows }
  });

  return {
    updatedRange: response.data.updatedRange,
    updatedRows: response.data.updatedRows,
    updatedCells: response.data.updatedCells
  };
}

/**
 * Export sheet data to CSV/TSV format
 */
async function exportData(spreadsheetId: string, range?: string, delimiter = ',') {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  if (!range) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    range = meta.data.sheets?.[0]?.properties?.title || 'Sheet1';
  }

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range
  });

  const rows = response.data.values || [];

  // Convert to CSV/TSV with proper escaping
  return rows.map(row =>
    row.map(cell => {
      const str = String(cell ?? '');
      // Quote if contains delimiter, newline, or quote
      if (str.includes(delimiter) || str.includes('\n') || str.includes('"')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }).join(delimiter)
  ).join('\n');
}

/**
 * Batch operations interface
 */
interface BatchOperation {
  op: 'write' | 'append' | 'clear';
  range?: string;
  values?: any[][];
  sheet?: string;
}

/**
 * Execute batch operations on a spreadsheet
 */
async function batchOperations(spreadsheetId: string, operations: BatchOperation[]) {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const results: any[] = [];

  for (const operation of operations) {
    switch (operation.op) {
      case 'write': {
        if (!operation.range || !operation.values) {
          results.push({ op: 'write', error: 'Missing range or values' });
          continue;
        }
        const response = await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: operation.range,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: operation.values }
        });
        results.push({
          op: 'write',
          range: response.data.updatedRange,
          updatedCells: response.data.updatedCells
        });
        break;
      }

      case 'append': {
        if (!operation.values) {
          results.push({ op: 'append', error: 'Missing values' });
          continue;
        }
        const targetSheet = operation.sheet || operation.range || 'Sheet1';
        const response = await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: targetSheet,
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: operation.values }
        });
        results.push({
          op: 'append',
          range: response.data.updates?.updatedRange,
          updatedRows: response.data.updates?.updatedRows
        });
        break;
      }

      case 'clear': {
        if (!operation.range) {
          results.push({ op: 'clear', error: 'Missing range' });
          continue;
        }
        const response = await sheets.spreadsheets.values.clear({
          spreadsheetId,
          range: operation.range
        });
        results.push({
          op: 'clear',
          clearedRange: response.data.clearedRange
        });
        break;
      }

      default:
        results.push({ op: (operation as any).op, error: 'Unknown operation' });
    }
  }

  return results;
}

/**
 * Read data from stdin (for piped input)
 */
async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');

    // Check if stdin has data (is piped)
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }

    process.stdin.on('readable', () => {
      let chunk;
      while ((chunk = process.stdin.read()) !== null) {
        data += chunk;
      }
    });

    process.stdin.on('end', () => {
      resolve(data);
    });
  });
}

// ============================================================================
// Phase 2: Sheet/Tab Management Commands
// ============================================================================

/**
 * Create a new sheet/tab in the spreadsheet
 */
async function addSheetTab(spreadsheetId: string, sheetName: string) {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        addSheet: {
          properties: {
            title: sheetName
          }
        }
      }]
    }
  });

  const newSheet = response.data.replies?.[0]?.addSheet?.properties;
  return {
    title: newSheet?.title,
    sheetId: newSheet?.sheetId,
    index: newSheet?.index
  };
}

/**
 * Delete a sheet/tab from the spreadsheet
 */
async function deleteSheetTab(spreadsheetId: string, sheetName: string) {
  const sheetId = await getSheetId(spreadsheetId, sheetName);
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        deleteSheet: {
          sheetId
        }
      }]
    }
  });

  return { deleted: sheetName, sheetId };
}

/**
 * Rename a sheet/tab in the spreadsheet
 */
async function renameSheetTab(spreadsheetId: string, oldName: string, newName: string) {
  const sheetId = await getSheetId(spreadsheetId, oldName);
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        updateSheetProperties: {
          properties: {
            sheetId,
            title: newName
          },
          fields: 'title'
        }
      }]
    }
  });

  return { oldName, newName, sheetId };
}

/**
 * Copy a sheet/tab (within same spreadsheet or to another)
 */
async function copySheetTab(spreadsheetId: string, sheetName: string, destinationId?: string) {
  const sheetId = await getSheetId(spreadsheetId, sheetName);
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.sheets.copyTo({
    spreadsheetId,
    sheetId,
    requestBody: {
      destinationSpreadsheetId: destinationId || spreadsheetId
    }
  });

  return {
    title: response.data.title,
    sheetId: response.data.sheetId,
    index: response.data.index,
    destinationSpreadsheetId: destinationId || spreadsheetId
  };
}

/**
 * Duplicate an entire spreadsheet (creates a new copy via Drive API)
 */
async function duplicateSpreadsheet(spreadsheetId: string, newName?: string) {
  const auth = await getAuthClient();
  const drive = google.drive({ version: 'v3', auth });

  // Get original name if not provided
  if (!newName) {
    const sheets = google.sheets({ version: 'v4', auth });
    const original = await sheets.spreadsheets.get({ spreadsheetId });
    newName = `Copy of ${original.data.properties?.title}`;
  }

  const response = await drive.files.copy({
    fileId: spreadsheetId,
    requestBody: {
      name: newName
    }
  });

  return {
    id: response.data.id,
    name: response.data.name
  };
}

// ============================================================================
// Phase 3: Data Intelligence Functions
// ============================================================================

interface FindResult {
  row: number;
  col: number;
  colLetter: string;
  value: string;
  cell: string;
}

/**
 * Convert 0-indexed column number to letter (0=A, 25=Z, 26=AA)
 */
function indexToColumn(index: number): string {
  let result = '';
  let i = index;
  while (i >= 0) {
    result = String.fromCharCode((i % 26) + 65) + result;
    i = Math.floor(i / 26) - 1;
  }
  return result;
}

/**
 * Search for values in a sheet and return cell positions
 */
async function findInSheet(spreadsheetId: string, searchTerm: string, sheetName?: string): Promise<FindResult[]> {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  if (!sheetName) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    sheetName = meta.data.sheets?.[0]?.properties?.title || 'Sheet1';
  }

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: sheetName
  });

  const data = response.data.values || [];
  const results: FindResult[] = [];
  const searchLower = searchTerm.toLowerCase();

  data.forEach((row, rowIndex) => {
    row.forEach((cell, colIndex) => {
      const cellStr = String(cell);
      if (cellStr.toLowerCase().includes(searchLower)) {
        const colLetter = indexToColumn(colIndex);
        results.push({
          row: rowIndex + 1,
          col: colIndex + 1,
          colLetter,
          value: cellStr,
          cell: `${colLetter}${rowIndex + 1}`
        });
      }
    });
  });

  return results;
}

interface SortOptions {
  column: string;
  descending: boolean;
}

/**
 * Sort a range by a specified column
 */
async function sortRange(spreadsheetId: string, range: string, options: SortOptions) {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const parsed = parseA1Range(range);
  const sheetName = parsed.sheetName || 'Sheet1';
  const sheetId = await getSheetId(spreadsheetId, sheetName);

  // Calculate column index for sorting (0-indexed)
  const sortColIndex = columnToIndex(options.column.toUpperCase());

  if (sortColIndex < parsed.startColumnIndex || sortColIndex >= parsed.endColumnIndex) {
    throw new Error(`Sort column ${options.column} is outside the range`);
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        sortRange: {
          range: {
            sheetId,
            startRowIndex: parsed.startRowIndex,
            endRowIndex: parsed.endRowIndex,
            startColumnIndex: parsed.startColumnIndex,
            endColumnIndex: parsed.endColumnIndex
          },
          sortSpecs: [{
            dimensionIndex: sortColIndex,
            sortOrder: options.descending ? 'DESCENDING' : 'ASCENDING'
          }]
        }
      }]
    }
  });

  return {
    success: true,
    range,
    sortedBy: options.column,
    order: options.descending ? 'descending' : 'ascending'
  };
}

interface FilterOptions {
  column: string;
  gt?: number;
  lt?: number;
  gte?: number;
  lte?: number;
  eq?: string;
  neq?: string;
  contains?: string;
  notContains?: string;
}

/**
 * Filter rows based on column conditions
 */
async function filterRows(spreadsheetId: string, range: string, options: FilterOptions): Promise<{ headers: string[]; rows: any[][]; matchCount: number }> {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const parsed = parseA1Range(range);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range
  });

  const data = response.data.values || [];
  if (data.length === 0) {
    return { headers: [], rows: [], matchCount: 0 };
  }

  // First row is headers
  const headers = data[0].map(String);
  const rows = data.slice(1);

  // Find column index relative to range start
  const colIndex = columnToIndex(options.column.toUpperCase()) - parsed.startColumnIndex;
  if (colIndex < 0 || colIndex >= headers.length) {
    throw new Error(`Column ${options.column} is outside the range`);
  }

  const filteredRows = rows.filter(row => {
    const cellValue = row[colIndex];
    if (cellValue === undefined || cellValue === null) return false;

    const strValue = String(cellValue);
    const numValue = parseFloat(strValue);

    if (options.gt !== undefined && (isNaN(numValue) || numValue <= options.gt)) return false;
    if (options.lt !== undefined && (isNaN(numValue) || numValue >= options.lt)) return false;
    if (options.gte !== undefined && (isNaN(numValue) || numValue < options.gte)) return false;
    if (options.lte !== undefined && (isNaN(numValue) || numValue > options.lte)) return false;
    if (options.eq !== undefined && strValue !== options.eq) return false;
    if (options.neq !== undefined && strValue === options.neq) return false;
    if (options.contains !== undefined && !strValue.toLowerCase().includes(options.contains.toLowerCase())) return false;
    if (options.notContains !== undefined && strValue.toLowerCase().includes(options.notContains.toLowerCase())) return false;

    return true;
  });

  return {
    headers,
    rows: filteredRows,
    matchCount: filteredRows.length
  };
}

/**
 * Set a formula in a cell
 */
async function setFormula(spreadsheetId: string, cell: string, formula: string) {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: cell,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[formula]]
    }
  });

  return {
    cell,
    formula,
    updatedCells: response.data.updatedCells
  };
}

interface NamedRange {
  name: string;
  range: string;
  namedRangeId?: string;
}

/**
 * List all named ranges in a spreadsheet
 */
async function listNamedRanges(spreadsheetId: string): Promise<NamedRange[]> {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.get({ spreadsheetId });
  const namedRanges = response.data.namedRanges || [];
  const sheetsData = response.data.sheets || [];

  return namedRanges.map(nr => {
    const range = nr.range;
    let rangeStr = '';

    if (range) {
      // Find sheet name
      const sheet = sheetsData.find(s => s.properties?.sheetId === range.sheetId);
      const sheetName = sheet?.properties?.title || 'Sheet1';

      // Convert grid range to A1 notation
      const startCol = indexToColumn(range.startColumnIndex || 0);
      const endCol = indexToColumn((range.endColumnIndex || 1) - 1);
      const startRow = (range.startRowIndex || 0) + 1;
      const endRow = range.endRowIndex || startRow;

      rangeStr = `${sheetName}!${startCol}${startRow}:${endCol}${endRow}`;
    }

    return {
      name: nr.name || '',
      range: rangeStr,
      namedRangeId: nr.namedRangeId
    };
  });
}

/**
 * Add a named range to a spreadsheet
 */
async function addNamedRange(spreadsheetId: string, name: string, range: string) {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const parsed = parseA1Range(range);
  const sheetName = parsed.sheetName || 'Sheet1';
  const sheetId = await getSheetId(spreadsheetId, sheetName);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        addNamedRange: {
          namedRange: {
            name,
            range: {
              sheetId,
              startRowIndex: parsed.startRowIndex,
              endRowIndex: parsed.endRowIndex,
              startColumnIndex: parsed.startColumnIndex,
              endColumnIndex: parsed.endColumnIndex
            }
          }
        }
      }]
    }
  });

  return {
    success: true,
    name,
    range
  };
}

/**
 * Delete a named range from a spreadsheet
 */
async function deleteNamedRange(spreadsheetId: string, name: string) {
  const auth = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  // First, find the named range ID
  const namedRanges = await listNamedRanges(spreadsheetId);
  const target = namedRanges.find(nr => nr.name === name);

  if (!target || !target.namedRangeId) {
    throw new Error(`Named range "${name}" not found`);
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        deleteNamedRange: {
          namedRangeId: target.namedRangeId
        }
      }]
    }
  });

  return {
    success: true,
    deleted: name
  };
}

function showHelp() {
  console.log(`${COLORS.cyan}kaya-cli sheets${COLORS.nc} - Google Sheets CLI

${COLORS.blue}Usage:${COLORS.nc}
  kaya-cli sheets <command> [options]

${COLORS.blue}Commands:${COLORS.nc}
  ${COLORS.green}list${COLORS.nc} [--limit N]           List recent spreadsheets (default: 10)
  ${COLORS.green}create${COLORS.nc} <name>              Create a new spreadsheet
  ${COLORS.green}read${COLORS.nc} <id> [range]          Read data from sheet
  ${COLORS.green}write${COLORS.nc} <id> <range> <json>  Write data to sheet
  ${COLORS.green}append${COLORS.nc} <id> <json>         Append rows to sheet
  ${COLORS.green}clear${COLORS.nc} <id> <range>         Clear range without deleting
  ${COLORS.green}delete-rows${COLORS.nc} <id> <sheet> <start:end>  Delete rows
  ${COLORS.green}import${COLORS.nc} <id> [sheet]        Import CSV/TSV from stdin
  ${COLORS.green}export${COLORS.nc} <id> [range]        Export to CSV/TSV
  ${COLORS.green}batch${COLORS.nc} <id> <json>          Execute batch operations
  ${COLORS.green}info${COLORS.nc} <id>                  Get spreadsheet metadata
  ${COLORS.green}format${COLORS.nc} <id> <range>        Apply cell formatting
  ${COLORS.green}freeze${COLORS.nc} <id> <sheet>        Freeze rows/columns
  ${COLORS.green}share${COLORS.nc} <id> <email>         Share spreadsheet with user
  ${COLORS.green}permissions${COLORS.nc} <id>           List who has access
  ${COLORS.green}protect${COLORS.nc} <id> <range>       Protect a range from edits

${COLORS.blue}Sheet/Tab Management:${COLORS.nc}
  ${COLORS.green}add-sheet${COLORS.nc} <id> <name>      Create a new sheet/tab
  ${COLORS.green}delete-sheet${COLORS.nc} <id> <name>   Delete a sheet/tab
  ${COLORS.green}rename-sheet${COLORS.nc} <id> <old> <new>  Rename a sheet/tab
  ${COLORS.green}copy-sheet${COLORS.nc} <id> <name>     Copy sheet (--to <dest_id> for cross-spreadsheet)
  ${COLORS.green}duplicate${COLORS.nc} <id> [name]      Clone entire spreadsheet

${COLORS.blue}Data Intelligence:${COLORS.nc}
  ${COLORS.green}find${COLORS.nc} <id> "term"           Search for values in sheet
  ${COLORS.green}sort${COLORS.nc} <id> <range>          Sort range by column
  ${COLORS.green}filter${COLORS.nc} <id> <range>        Filter rows by condition
  ${COLORS.green}formula${COLORS.nc} <id> <cell> <formula>  Set formula in cell
  ${COLORS.green}named-ranges${COLORS.nc} <id> <action> Manage named ranges (list/add/delete)
  ${COLORS.green}help${COLORS.nc}                       Show this help

${COLORS.blue}Options:${COLORS.nc}
  --json                        Output as JSON
  --toon                        Output as TOON (token-efficient format for arrays)
  --tsv                         Output as TSV
  --limit N                     Limit results

${COLORS.blue}Format Options:${COLORS.nc}
  --bold                        Apply bold text
  --italic                      Apply italic text
  --bg=#RRGGBB                  Background color (hex)
  --fg=#RRGGBB                  Foreground/text color (hex)
  --align=left|center|right     Horizontal alignment

${COLORS.blue}Freeze Options:${COLORS.nc}
  --rows=N                      Freeze N rows from top
  --cols=N                      Freeze N columns from left

${COLORS.blue}Share Options:${COLORS.nc}
  --role=reader|writer|commenter  Permission level (default: reader)

${COLORS.blue}Protect Options:${COLORS.nc}
  --description="text"          Description for protected range

${COLORS.blue}Find Options:${COLORS.nc}
  --sheet="Name"                Search specific sheet (default: first sheet)

${COLORS.blue}Sort Options:${COLORS.nc}
  --by=COLUMN                   Column to sort by (e.g., --by=B)
  --desc                        Sort descending (default: ascending)

${COLORS.blue}Filter Options:${COLORS.nc}
  --col=COLUMN                  Column to filter on (e.g., --col=B)
  --gt=N                        Greater than N
  --lt=N                        Less than N
  --gte=N                       Greater than or equal to N
  --lte=N                       Less than or equal to N
  --eq="value"                  Equals value (exact match)
  --contains="text"             Contains text (case-insensitive)

${COLORS.blue}Named Ranges Actions:${COLORS.nc}
  list                          List all named ranges
  add <name> <range>            Add named range
  delete <name>                 Delete named range

${COLORS.blue}Examples:${COLORS.nc}
  kaya-cli sheets list
  kaya-cli sheets create "My Spreadsheet"
  kaya-cli sheets read 1abc123 "Sheet1!A1:D10"
  kaya-cli sheets write 1abc123 "A1:B2" '[["a","b"],["c","d"]]'
  kaya-cli sheets append 1abc123 '[["new","row"]]'
  kaya-cli sheets clear 1abc123 "A1:D10"
  kaya-cli sheets delete-rows 1abc123 Sheet1 5:10
  cat data.csv | kaya-cli sheets import 1abc123
  kaya-cli sheets export 1abc123 --csv > out.csv
  kaya-cli sheets export 1abc123 "Sheet1!A1:D10" --tsv
  kaya-cli sheets batch 1abc123 '[{"op":"write","range":"A1","values":[["x"]]}]'
  kaya-cli sheets info 1abc123 --json
  kaya-cli sheets format 1abc123 "A1:B1" --bold --bg=#4285F4 --fg=#FFFFFF
  kaya-cli sheets freeze 1abc123 "Sheet1" --rows=1 --cols=1
  kaya-cli sheets share 1abc123 user@example.com --role=editor
  kaya-cli sheets permissions 1abc123
  kaya-cli sheets protect 1abc123 "Sheet1!A1:A10" --description="Header row"

${COLORS.blue}Sheet Management Examples:${COLORS.nc}
  kaya-cli sheets add-sheet 1abc123 "New Tab"
  kaya-cli sheets delete-sheet 1abc123 "Old Tab"
  kaya-cli sheets rename-sheet 1abc123 "Sheet1" "Data"
  kaya-cli sheets copy-sheet 1abc123 "Template"
  kaya-cli sheets copy-sheet 1abc123 "Template" --to 2xyz456
  kaya-cli sheets duplicate 1abc123 "My Copy"

${COLORS.blue}Data Intelligence Examples:${COLORS.nc}
  kaya-cli sheets find 1abc123 "search term" --sheet="Data"
  kaya-cli sheets sort 1abc123 "A1:D100" --by=B --desc
  kaya-cli sheets filter 1abc123 "A1:D100" --col=B --gt=100
  kaya-cli sheets filter 1abc123 "A1:D100" --col=C --contains="active"
  kaya-cli sheets formula 1abc123 "E2" "=SUM(A2:D2)"
  kaya-cli sheets named-ranges 1abc123 list
  kaya-cli sheets named-ranges 1abc123 add "Sales" "Sheet1!A1:B10"
  kaya-cli sheets named-ranges 1abc123 delete "Sales"

${COLORS.blue}Data Format:${COLORS.nc}
  Write/append data as JSON array of arrays:
  '[["row1col1","row1col2"],["row2col1","row2col2"]]'
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    showHelp();
    process.exit(0);
  }

  const command = args[0];
  const jsonOutput = args.includes('--json');
  const toonOutput = args.includes('--toon');
  const tsvOutput = args.includes('--tsv');
  const filteredArgs = args.filter(a => !a.startsWith('--'));

  try {
    switch (command) {
      case 'list': {
        const limitIdx = args.indexOf('--limit');
        const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : 10;
        const files = await listSpreadsheets(limit);

        if (toonOutput) {
          const result = maybeEncode(files as unknown[]);
          console.log(result.data);
        } else if (jsonOutput) {
          console.log(JSON.stringify(files, null, 2));
        } else if (tsvOutput) {
          files.forEach(f => console.log(`${f.id}\t${f.name}\t${f.modifiedTime}`));
        } else {
          console.log(`${COLORS.cyan}Recent Spreadsheets:${COLORS.nc}\n`);
          files.forEach(f => {
            console.log(`  ${COLORS.green}${f.name}${COLORS.nc}`);
            console.log(`    ID: ${f.id}`);
            console.log(`    Modified: ${f.modifiedTime}\n`);
          });
        }
        break;
      }

      case 'create': {
        const title = filteredArgs[1];

        if (!title) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Usage: sheets create <name>`);
          process.exit(1);
        }

        const result = await createSpreadsheet(title);

        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`${COLORS.green}Created${COLORS.nc} "${result.title}"`);
          console.log(`  ID: ${result.spreadsheetId}`);
          console.log(`  URL: ${result.url}`);
        }
        break;
      }

      case 'clear': {
        const spreadsheetId = filteredArgs[1];
        const range = filteredArgs[2];

        if (!spreadsheetId || !range) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Usage: sheets clear <id> <range>`);
          process.exit(1);
        }

        const result = await clearRange(spreadsheetId, range);

        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`${COLORS.green}Cleared${COLORS.nc} ${result.clearedRange}`);
        }
        break;
      }

      case 'delete-rows': {
        const spreadsheetId = filteredArgs[1];
        const sheetName = filteredArgs[2];
        const rowRange = filteredArgs[3];

        if (!spreadsheetId || !sheetName || !rowRange) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Usage: sheets delete-rows <id> <sheet> <start:end>`);
          console.error(`  Example: sheets delete-rows 1abc123 Sheet1 5:10`);
          process.exit(1);
        }

        const [startStr, endStr] = rowRange.split(':');
        const startRow = parseInt(startStr);
        const endRow = parseInt(endStr);

        if (isNaN(startRow) || isNaN(endRow)) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Invalid row range. Use format: start:end (e.g., 5:10)`);
          process.exit(1);
        }

        const result = await deleteRows(spreadsheetId, sheetName, startRow, endRow);

        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`${COLORS.green}Deleted${COLORS.nc} ${result.deletedRows} rows from "${sheetName}"`);
        }
        break;
      }

      case 'import': {
        const spreadsheetId = filteredArgs[1];
        const sheetName = filteredArgs[2];

        if (!spreadsheetId) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Usage: cat data.csv | sheets import <id> [sheet]`);
          process.exit(1);
        }

        const stdinData = await readStdin();

        if (!stdinData) {
          console.error(`${COLORS.red}Error:${COLORS.nc} No data received from stdin. Pipe CSV/TSV data to this command.`);
          console.error(`  Example: cat data.csv | kaya-cli sheets import ${spreadsheetId}`);
          process.exit(1);
        }

        const csvOutput = args.includes('--csv');
        const delimiter = tsvOutput ? '\t' : ',';
        const result = await importData(spreadsheetId, stdinData, sheetName, delimiter);

        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`${COLORS.green}Imported${COLORS.nc} ${result.updatedRows} rows (${result.updatedCells} cells) to ${result.updatedRange}`);
        }
        break;
      }

      case 'export': {
        const spreadsheetId = filteredArgs[1];
        const range = filteredArgs[2];

        if (!spreadsheetId) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Usage: sheets export <id> [range] [--csv|--tsv]`);
          process.exit(1);
        }

        const csvOutput = args.includes('--csv');
        const delimiter = tsvOutput ? '\t' : ',';
        const data = await exportData(spreadsheetId, range, delimiter);

        // Export outputs raw data for piping
        console.log(data);
        break;
      }

      case 'batch': {
        const spreadsheetId = filteredArgs[1];
        const opsStr = filteredArgs[2];

        if (!spreadsheetId || !opsStr) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Usage: sheets batch <id> <json-operations>`);
          console.error(`  Example: sheets batch 1abc123 '[{"op":"write","range":"A1","values":[["x"]]}]'`);
          process.exit(1);
        }

        const operations = JSON.parse(opsStr) as BatchOperation[];
        const results = await batchOperations(spreadsheetId, operations);

        if (jsonOutput) {
          console.log(JSON.stringify(results, null, 2));
        } else {
          console.log(`${COLORS.cyan}Batch Results:${COLORS.nc}`);
          results.forEach((r, i) => {
            if (r.error) {
              console.log(`  ${i + 1}. ${COLORS.red}${r.op}${COLORS.nc}: ${r.error}`);
            } else {
              console.log(`  ${i + 1}. ${COLORS.green}${r.op}${COLORS.nc}: ${r.range || r.clearedRange}`);
            }
          });
        }
        break;
      }

      case 'read': {
        const spreadsheetId = filteredArgs[1];
        const range = filteredArgs[2];

        if (!spreadsheetId) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Spreadsheet ID required`);
          process.exit(1);
        }

        const data = await readSheet(spreadsheetId, range);

        if (toonOutput) {
          const result = maybeEncode(data as unknown[]);
          console.log(result.data);
        } else if (jsonOutput) {
          console.log(JSON.stringify(data, null, 2));
        } else if (tsvOutput) {
          data.forEach(row => console.log(row.join('\t')));
        } else {
          data.forEach(row => console.log(row.join(' | ')));
        }
        break;
      }

      case 'write': {
        const spreadsheetId = filteredArgs[1];
        const range = filteredArgs[2];
        const dataStr = filteredArgs[3];

        if (!spreadsheetId || !range || !dataStr) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Usage: sheets write <id> <range> <json-data>`);
          process.exit(1);
        }

        const values = JSON.parse(dataStr);
        const result = await writeSheet(spreadsheetId, range, values);

        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`${COLORS.green}Updated${COLORS.nc} ${result.updatedCells} cells in ${result.updatedRange}`);
        }
        break;
      }

      case 'append': {
        const spreadsheetId = filteredArgs[1];
        const dataStr = filteredArgs[2];

        if (!spreadsheetId || !dataStr) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Usage: sheets append <id> <json-data>`);
          process.exit(1);
        }

        const values = JSON.parse(dataStr);
        const result = await appendToSheet(spreadsheetId, values);

        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`${COLORS.green}Appended${COLORS.nc} ${result.updates?.updatedRows} rows`);
        }
        break;
      }

      case 'info': {
        const spreadsheetId = filteredArgs[1];

        if (!spreadsheetId) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Spreadsheet ID required`);
          process.exit(1);
        }

        const info = await getSheetInfo(spreadsheetId);

        if (jsonOutput) {
          console.log(JSON.stringify(info, null, 2));
        } else {
          console.log(`${COLORS.cyan}${info.title}${COLORS.nc}\n`);
          console.log(`Locale: ${info.locale}`);
          console.log(`\n${COLORS.blue}Sheets:${COLORS.nc}`);
          info.sheets?.forEach(s => {
            console.log(`  ${COLORS.green}${s.title}${COLORS.nc} (${s.rows}x${s.cols})`);
          });
        }
        break;
      }

      case 'format': {
        const spreadsheetId = filteredArgs[1];
        const range = filteredArgs[2];

        if (!spreadsheetId || !range) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Usage: sheets format <id> <range> [--bold] [--italic] [--bg=#HEX] [--fg=#HEX] [--align=left|center|right]`);
          process.exit(1);
        }

        const options: { bold?: boolean; italic?: boolean; bgColor?: string; fgColor?: string; align?: 'left' | 'center' | 'right' } = {};
        if (args.includes('--bold')) options.bold = true;
        if (args.includes('--italic')) options.italic = true;
        const bgArg = args.find(a => a.startsWith('--bg='));
        if (bgArg) options.bgColor = bgArg.split('=')[1];
        const fgArg = args.find(a => a.startsWith('--fg='));
        if (fgArg) options.fgColor = fgArg.split('=')[1];
        const alignArg = args.find(a => a.startsWith('--align='));
        if (alignArg) options.align = alignArg.split('=')[1] as 'left' | 'center' | 'right';

        const result = await formatRange(spreadsheetId, range, options);

        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`${COLORS.green}Formatted${COLORS.nc} ${range}: ${result.appliedFormats.join(', ')}`);
        }
        break;
      }

      case 'freeze': {
        const spreadsheetId = filteredArgs[1];
        const sheetName = filteredArgs[2];

        if (!spreadsheetId || !sheetName) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Usage: sheets freeze <id> <sheet> [--rows=N] [--cols=N]`);
          process.exit(1);
        }

        const options: { rows?: number; cols?: number } = {};
        const rowsArg = args.find(a => a.startsWith('--rows='));
        if (rowsArg) options.rows = parseInt(rowsArg.split('=')[1]);
        const colsArg = args.find(a => a.startsWith('--cols='));
        if (colsArg) options.cols = parseInt(colsArg.split('=')[1]);

        const result = await freezeRowsCols(spreadsheetId, sheetName, options);

        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const parts = [];
          if (result.frozenRows) parts.push(`${result.frozenRows} rows`);
          if (result.frozenCols) parts.push(`${result.frozenCols} columns`);
          console.log(`${COLORS.green}Froze${COLORS.nc} ${parts.join(' and ')} in "${sheetName}"`);
        }
        break;
      }

      case 'share': {
        const spreadsheetId = filteredArgs[1];
        const email = filteredArgs[2];

        if (!spreadsheetId || !email) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Usage: sheets share <id> <email> [--role=reader|writer|commenter]`);
          process.exit(1);
        }

        const roleArg = args.find(a => a.startsWith('--role='));
        const role = (roleArg ? roleArg.split('=')[1] : 'reader') as 'reader' | 'writer' | 'commenter';

        const result = await shareSpreadsheet(spreadsheetId, email, role);

        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`${COLORS.green}Shared${COLORS.nc} with ${email} as ${role}`);
        }
        break;
      }

      case 'permissions': {
        const spreadsheetId = filteredArgs[1];

        if (!spreadsheetId) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Spreadsheet ID required`);
          process.exit(1);
        }

        const permissions = await listPermissions(spreadsheetId);

        if (toonOutput) {
          const encoded = maybeEncode(permissions as unknown[]);
          console.log(encoded.data);
        } else if (jsonOutput) {
          console.log(JSON.stringify(permissions, null, 2));
        } else {
          console.log(`${COLORS.cyan}Permissions:${COLORS.nc}\n`);
          permissions.forEach((p: any) => {
            const name = p.displayName || p.emailAddress || p.type;
            console.log(`  ${COLORS.green}${name}${COLORS.nc} - ${p.role}`);
          });
        }
        break;
      }

      case 'protect': {
        const spreadsheetId = filteredArgs[1];
        const range = filteredArgs[2];

        if (!spreadsheetId || !range) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Usage: sheets protect <id> <range> [--description="text"]`);
          process.exit(1);
        }

        const descArg = args.find(a => a.startsWith('--description='));
        const description = descArg ? descArg.split('=')[1].replace(/^["']|["']$/g, '') : undefined;

        const result = await protectRange(spreadsheetId, range, description);

        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`${COLORS.green}Protected${COLORS.nc} ${range}`);
        }
        break;
      }

      // Phase 2: Sheet/Tab Management Commands

      case 'add-sheet': {
        const spreadsheetId = filteredArgs[1];
        const sheetName = filteredArgs[2];

        if (!spreadsheetId || !sheetName) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Usage: sheets add-sheet <id> <name>`);
          process.exit(1);
        }

        const result = await addSheetTab(spreadsheetId, sheetName);

        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`${COLORS.green}Created${COLORS.nc} sheet "${result.title}" (ID: ${result.sheetId})`);
        }
        break;
      }

      case 'delete-sheet': {
        const spreadsheetId = filteredArgs[1];
        const sheetName = filteredArgs[2];

        if (!spreadsheetId || !sheetName) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Usage: sheets delete-sheet <id> <name>`);
          process.exit(1);
        }

        const result = await deleteSheetTab(spreadsheetId, sheetName);

        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`${COLORS.green}Deleted${COLORS.nc} sheet "${result.deleted}"`);
        }
        break;
      }

      case 'rename-sheet': {
        const spreadsheetId = filteredArgs[1];
        const oldName = filteredArgs[2];
        const newName = filteredArgs[3];

        if (!spreadsheetId || !oldName || !newName) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Usage: sheets rename-sheet <id> <old-name> <new-name>`);
          process.exit(1);
        }

        const result = await renameSheetTab(spreadsheetId, oldName, newName);

        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`${COLORS.green}Renamed${COLORS.nc} "${result.oldName}" to "${result.newName}"`);
        }
        break;
      }

      case 'copy-sheet': {
        const spreadsheetId = filteredArgs[1];
        const sheetName = filteredArgs[2];

        if (!spreadsheetId || !sheetName) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Usage: sheets copy-sheet <id> <name> [--to <dest_id>]`);
          process.exit(1);
        }

        const toIdx = args.indexOf('--to');
        const destinationId = toIdx >= 0 ? args[toIdx + 1] : undefined;

        const result = await copySheetTab(spreadsheetId, sheetName, destinationId);

        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const dest = destinationId ? ` to spreadsheet ${destinationId}` : '';
          console.log(`${COLORS.green}Copied${COLORS.nc} "${sheetName}" as "${result.title}"${dest}`);
        }
        break;
      }

      case 'duplicate': {
        const spreadsheetId = filteredArgs[1];
        const newName = filteredArgs[2];

        if (!spreadsheetId) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Usage: sheets duplicate <id> [new-name]`);
          process.exit(1);
        }

        const result = await duplicateSpreadsheet(spreadsheetId, newName);

        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`${COLORS.green}Duplicated${COLORS.nc} as "${result.name}"`);
          console.log(`  New ID: ${result.id}`);
        }
        break;
      }

      // Phase 3: Data Intelligence Commands

      case 'find': {
        const spreadsheetId = filteredArgs[1];
        const searchTerm = filteredArgs[2];

        if (!spreadsheetId || !searchTerm) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Usage: sheets find <id> "search term" [--sheet="Name"]`);
          process.exit(1);
        }

        const sheetArg = args.find(a => a.startsWith('--sheet='));
        const sheetName = sheetArg ? sheetArg.split('=')[1].replace(/^["']|["']$/g, '') : undefined;

        const results = await findInSheet(spreadsheetId, searchTerm, sheetName);

        if (toonOutput) {
          const encoded = maybeEncode(results);
          console.log(encoded.data);
        } else if (jsonOutput) {
          console.log(JSON.stringify(results, null, 2));
        } else if (results.length === 0) {
          console.log(`${COLORS.yellow}No matches found${COLORS.nc} for "${searchTerm}"`);
        } else {
          console.log(`${COLORS.cyan}Found ${results.length} matches:${COLORS.nc}\n`);
          results.forEach(r => {
            console.log(`  ${COLORS.green}${r.cell}${COLORS.nc}: ${r.value}`);
          });
        }
        break;
      }

      case 'sort': {
        const spreadsheetId = filteredArgs[1];
        const range = filteredArgs[2];

        if (!spreadsheetId || !range) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Usage: sheets sort <id> <range> --by=COLUMN [--desc]`);
          process.exit(1);
        }

        const byArg = args.find(a => a.startsWith('--by='));
        if (!byArg) {
          console.error(`${COLORS.red}Error:${COLORS.nc} --by=COLUMN is required (e.g., --by=B)`);
          process.exit(1);
        }
        const column = byArg.split('=')[1];
        const descending = args.includes('--desc');

        const result = await sortRange(spreadsheetId, range, { column, descending });

        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`${COLORS.green}Sorted${COLORS.nc} ${range} by column ${column} (${result.order})`);
        }
        break;
      }

      case 'filter': {
        const spreadsheetId = filteredArgs[1];
        const range = filteredArgs[2];

        if (!spreadsheetId || !range) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Usage: sheets filter <id> <range> --col=COLUMN [--gt=N] [--lt=N] [--eq="value"] [--contains="text"]`);
          process.exit(1);
        }

        const colArg = args.find(a => a.startsWith('--col='));
        if (!colArg) {
          console.error(`${COLORS.red}Error:${COLORS.nc} --col=COLUMN is required (e.g., --col=B)`);
          process.exit(1);
        }

        const filterOpts: FilterOptions = { column: colArg.split('=')[1] };

        const gtArg = args.find(a => a.startsWith('--gt='));
        if (gtArg) filterOpts.gt = parseFloat(gtArg.split('=')[1]);
        const ltArg = args.find(a => a.startsWith('--lt='));
        if (ltArg) filterOpts.lt = parseFloat(ltArg.split('=')[1]);
        const gteArg = args.find(a => a.startsWith('--gte='));
        if (gteArg) filterOpts.gte = parseFloat(gteArg.split('=')[1]);
        const lteArg = args.find(a => a.startsWith('--lte='));
        if (lteArg) filterOpts.lte = parseFloat(lteArg.split('=')[1]);
        const eqArg = args.find(a => a.startsWith('--eq='));
        if (eqArg) filterOpts.eq = eqArg.split('=')[1].replace(/^["']|["']$/g, '');
        const neqArg = args.find(a => a.startsWith('--neq='));
        if (neqArg) filterOpts.neq = neqArg.split('=')[1].replace(/^["']|["']$/g, '');
        const containsArg = args.find(a => a.startsWith('--contains='));
        if (containsArg) filterOpts.contains = containsArg.split('=')[1].replace(/^["']|["']$/g, '');

        const result = await filterRows(spreadsheetId, range, filterOpts);

        if (toonOutput) {
          const encoded = maybeEncode(result.rows as unknown[]);
          console.log(encoded.data);
        } else if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else if (result.matchCount === 0) {
          console.log(`${COLORS.yellow}No matching rows found${COLORS.nc}`);
        } else {
          console.log(`${COLORS.cyan}Found ${result.matchCount} matching rows:${COLORS.nc}\n`);
          console.log(`  ${COLORS.blue}${result.headers.join(' | ')}${COLORS.nc}`);
          console.log(`  ${'-'.repeat(result.headers.join(' | ').length)}`);
          result.rows.forEach(row => {
            console.log(`  ${row.join(' | ')}`);
          });
        }
        break;
      }

      case 'formula': {
        const spreadsheetId = filteredArgs[1];
        const cell = filteredArgs[2];
        const formula = filteredArgs[3];

        if (!spreadsheetId || !cell || !formula) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Usage: sheets formula <id> <cell> <formula>`);
          console.error(`  Example: sheets formula 1abc123 "E2" "=SUM(A2:D2)"`);
          process.exit(1);
        }

        const result = await setFormula(spreadsheetId, cell, formula);

        if (jsonOutput) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`${COLORS.green}Set formula${COLORS.nc} in ${cell}: ${formula}`);
        }
        break;
      }

      case 'named-ranges': {
        const spreadsheetId = filteredArgs[1];
        const action = filteredArgs[2];

        if (!spreadsheetId || !action) {
          console.error(`${COLORS.red}Error:${COLORS.nc} Usage: sheets named-ranges <id> <action> [args]`);
          console.error(`  Actions: list, add <name> <range>, delete <name>`);
          process.exit(1);
        }

        switch (action) {
          case 'list': {
            const ranges = await listNamedRanges(spreadsheetId);

            if (toonOutput) {
              const encoded = maybeEncode(ranges as unknown[]);
              console.log(encoded.data);
            } else if (jsonOutput) {
              console.log(JSON.stringify(ranges, null, 2));
            } else if (ranges.length === 0) {
              console.log(`${COLORS.yellow}No named ranges found${COLORS.nc}`);
            } else {
              console.log(`${COLORS.cyan}Named Ranges:${COLORS.nc}\n`);
              ranges.forEach(r => {
                console.log(`  ${COLORS.green}${r.name}${COLORS.nc}: ${r.range}`);
              });
            }
            break;
          }

          case 'add': {
            const name = filteredArgs[3];
            const range = filteredArgs[4];

            if (!name || !range) {
              console.error(`${COLORS.red}Error:${COLORS.nc} Usage: sheets named-ranges <id> add <name> <range>`);
              console.error(`  Example: sheets named-ranges 1abc123 add "Sales" "Sheet1!A1:B10"`);
              process.exit(1);
            }

            const result = await addNamedRange(spreadsheetId, name, range);

            if (jsonOutput) {
              console.log(JSON.stringify(result, null, 2));
            } else {
              console.log(`${COLORS.green}Created${COLORS.nc} named range "${name}" -> ${range}`);
            }
            break;
          }

          case 'delete': {
            const name = filteredArgs[3];

            if (!name) {
              console.error(`${COLORS.red}Error:${COLORS.nc} Usage: sheets named-ranges <id> delete <name>`);
              process.exit(1);
            }

            const result = await deleteNamedRange(spreadsheetId, name);

            if (jsonOutput) {
              console.log(JSON.stringify(result, null, 2));
            } else {
              console.log(`${COLORS.green}Deleted${COLORS.nc} named range "${name}"`);
            }
            break;
          }

          default:
            console.error(`${COLORS.red}Error:${COLORS.nc} Unknown named-ranges action: ${action}`);
            console.error(`  Actions: list, add <name> <range>, delete <name>`);
            process.exit(1);
        }
        break;
      }

      default:
        console.error(`${COLORS.red}Error:${COLORS.nc} Unknown command: ${command}`);
        console.error(`Run 'kaya-cli sheets help' for usage`);
        process.exit(1);
    }
  } catch (error: any) {
    console.error(`${COLORS.red}Error:${COLORS.nc} ${error.message}`);
    process.exit(1);
  }
}

main();
