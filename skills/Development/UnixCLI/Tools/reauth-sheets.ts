#!/usr/bin/env bun
/**
 * reauth-sheets.ts - One-time/re-auth OAuth2 flow for Google Sheets CLI
 *
 * WHY: TokenHealth.ts (S7/B3) points expired/expiring sheets-token.json
 * remediation here. The old pointer (configure-google-auth.sh) only wires
 * gcalcli/rclone/gog — it has no Sheets OAuth path at all, so following it
 * for a Sheets credential failure was a dead end. Modeled on
 * lib/core/youtube-auth.ts's local-callback-server flow, but requests the
 * Sheets + Drive scopes that skills/Development/UnixCLI/Tools/Sheets.ts
 * actually calls (spreadsheets read/write via Sheets API, list/duplicate/
 * share via Drive API).
 *
 * Usage:
 *   bun ~/.claude/skills/Development/UnixCLI/Tools/reauth-sheets.ts
 *
 * Opens a browser for Google consent, then writes a fresh token to
 * ~/.config/google/sheets-token.json (overwriting any existing one — unlike
 * youtube-auth.ts, re-auth is the explicit point of running this script, so
 * an existing stale token must not block it).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { createServer } from 'http'
import { execSync } from 'child_process'

const CREDENTIALS_PATH = join(homedir(), '.config', 'google', 'credentials.json')
const TOKEN_PATH = join(homedir(), '.config', 'google', 'sheets-token.json')
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
]
const REDIRECT_PORT = 3848 // distinct from youtube-auth.ts's 3847 so both can run independently
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`

if (!existsSync(CREDENTIALS_PATH)) {
  console.error('Error: Google credentials not found at', CREDENTIALS_PATH)
  console.error('Download OAuth2 credentials from https://console.cloud.google.com/apis/credentials')
  console.error('(Desktop app type) and save them to', CREDENTIALS_PATH)
  process.exit(1)
}

const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'))
const { client_id, client_secret } = creds.installed || creds.web

if (!client_id || !client_secret) {
  console.error('Error: credentials.json at', CREDENTIALS_PATH, 'is missing client_id/client_secret')
  process.exit(1)
}

// Build auth URL
const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
authUrl.searchParams.set('client_id', client_id)
authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
authUrl.searchParams.set('response_type', 'code')
authUrl.searchParams.set('scope', SCOPES.join(' '))
authUrl.searchParams.set('access_type', 'offline')
authUrl.searchParams.set('prompt', 'consent')

console.log('\nOpening browser for Google Sheets authorization...\n')

// Start local server to catch the callback
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '', REDIRECT_URI)
  const code = url.searchParams.get('code')
  const error = url.searchParams.get('error')

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`<h2>Authorization failed: ${error}</h2><p>You can close this tab.</p>`)
    server.close()
    process.exit(1)
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html' })
    res.end('<h2>No authorization code received</h2>')
    return
  }

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id,
      client_secret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  })

  const tokenData = await tokenRes.json()

  if (tokenData.error) {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`<h2>Token exchange failed: ${tokenData.error_description}</h2>`)
    server.close()
    process.exit(1)
  }

  // Save token — same shape TokenHealth.ts/Sheets.ts expect (access_token,
  // refresh_token, token_type, expiry_date as ms epoch), overwriting any
  // existing (possibly expired) sheets-token.json.
  const token = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    scope: tokenData.scope,
    token_type: tokenData.token_type,
    expiry_date: Date.now() + tokenData.expires_in * 1000,
  }

  mkdirSync(dirname(TOKEN_PATH), { recursive: true })
  writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2))

  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end('<h2 style="color:green">✓ Google Sheets authorization successful!</h2><p>You can close this tab and return to the terminal.</p>')

  console.log('Token saved to', TOKEN_PATH)
  console.log('Google Sheets OAuth re-auth complete!\n')

  server.close()
  process.exit(0)
})

server.listen(REDIRECT_PORT, () => {
  // Open browser
  execSync(`open "${authUrl.toString()}"`)
  console.log('Waiting for authorization...')
  console.log('(If browser did not open, visit this URL manually:)')
  console.log(authUrl.toString(), '\n')
})
