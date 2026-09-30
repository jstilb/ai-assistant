#!/usr/bin/env bun
/**
 * youtube-auth.ts - One-time OAuth2 flow for YouTube Data API
 *
 * Usage:
 *   bun ~/.claude/lib/core/youtube-auth.ts
 *
 * Opens browser for Google consent, saves refresh token to
 * ~/.config/google/youtube-token.json
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { createServer } from 'http'

const CREDENTIALS_PATH = join(homedir(), '.config', 'google', 'credentials.json')
const TOKEN_PATH = join(homedir(), '.config', 'google', 'youtube-token.json')
const SCOPES = ['https://www.googleapis.com/auth/youtube.readonly']
const REDIRECT_PORT = 3847
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`

if (!existsSync(CREDENTIALS_PATH)) {
  console.error('Error: Google credentials not found at', CREDENTIALS_PATH)
  process.exit(1)
}

if (existsSync(TOKEN_PATH)) {
  console.log('YouTube token already exists at', TOKEN_PATH)
  console.log('Delete it first if you want to re-authenticate.')
  process.exit(0)
}

const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'))
const { client_id, client_secret } = creds.installed || creds.web

// Build auth URL
const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
authUrl.searchParams.set('client_id', client_id)
authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
authUrl.searchParams.set('response_type', 'code')
authUrl.searchParams.set('scope', SCOPES.join(' '))
authUrl.searchParams.set('access_type', 'offline')
authUrl.searchParams.set('prompt', 'consent')

console.log('\nOpening browser for Google authorization...\n')

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

  // Save token
  const token = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    scope: tokenData.scope,
    token_type: tokenData.token_type,
    expiry_date: Date.now() + tokenData.expires_in * 1000,
  }

  writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2))

  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end('<h2 style="color:green">✓ YouTube authorization successful!</h2><p>You can close this tab and return to the terminal.</p>')

  console.log('Token saved to', TOKEN_PATH)
  console.log('YouTube OAuth setup complete!\n')

  server.close()
  process.exit(0)
})

server.listen(REDIRECT_PORT, () => {
  // Open browser
  const { execSync } = require('child_process')
  execSync(`open "${authUrl.toString()}"`)
  console.log('Waiting for authorization...')
  console.log('(If browser did not open, visit this URL manually:)')
  console.log(authUrl.toString(), '\n')
})
