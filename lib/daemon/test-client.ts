#!/usr/bin/env bun

/**
 * WebSocket Test Client
 *
 * Simple test client to verify WebSocket server functionality
 * Run with: bun run lib/daemon/test-client.ts
 */

import type { WSMessage, WSRequest } from './types';

const WS_URL = 'ws://localhost:3737/ws';
const AUTH_TOKEN = process.env.DAEMON_AUTH_TOKEN || undefined;

async function testWebSocket() {
  console.log('🔌 Connecting to WebSocket server...');
  console.log(`   URL: ${WS_URL}`);
  if (AUTH_TOKEN) {
    console.log(`   Auth: Using token from DAEMON_AUTH_TOKEN`);
  } else {
    console.log(`   Auth: No token (auto-auth mode)`);
  }

  const ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('✅ Connected to server\n');

    // If auth required, send ping with token
    if (AUTH_TOKEN) {
      const authPing: WSRequest = {
        type: 'ping',
        payload: { timestamp: Date.now(), token: AUTH_TOKEN } as any,
        id: crypto.randomUUID(),
      };
      console.log('📤 Sending auth ping...');
      ws.send(JSON.stringify(authPing));
    } else {
      // Start tests immediately
      runTests(ws);
    }
  };

  ws.onmessage = (event) => {
    const message: WSMessage = JSON.parse(event.data);
    console.log('📥 Received:', message.type);
    console.log('   ', JSON.stringify(message.payload, null, 2));
    console.log('');

    // If auth successful, run tests
    if (message.type === 'auth.success') {
      console.log('✅ Authenticated successfully\n');
      runTests(ws);
    }
  };

  ws.onerror = (error) => {
    console.error('❌ WebSocket error:', error);
  };

  ws.onclose = (event) => {
    console.log(`🔌 Disconnected (code: ${event.code}, reason: ${event.reason})`);
  };
}

function runTests(ws: WebSocket) {
  console.log('🧪 Running test suite...\n');

  let testDelay = 1000; // 1 second between tests

  // Test 1: Ping
  setTimeout(() => {
    const ping: WSRequest = {
      type: 'ping',
      payload: { timestamp: Date.now() },
      id: crypto.randomUUID(),
    };
    console.log('📤 Test 1: Ping');
    ws.send(JSON.stringify(ping));
  }, testDelay);

  testDelay += 1000;

  // Test 2: Status
  setTimeout(() => {
    const status: WSRequest = {
      type: 'status',
      payload: {} as any,
      id: crypto.randomUUID(),
    };
    console.log('📤 Test 2: Status request');
    ws.send(JSON.stringify(status));
  }, testDelay);

  testDelay += 1000;

  // Test 3: Cron list
  setTimeout(() => {
    const cronList: WSRequest = {
      type: 'cron.list',
      payload: [] as any,
      id: crypto.randomUUID(),
    };
    console.log('📤 Test 3: Cron list request');
    ws.send(JSON.stringify(cronList));
  }, testDelay);

  testDelay += 1000;

  // Test 4: Queue status
  setTimeout(() => {
    const queueStatus: WSRequest = {
      type: 'queue.status',
      payload: {} as any,
      id: crypto.randomUUID(),
    };
    console.log('📤 Test 4: Queue status request');
    ws.send(JSON.stringify(queueStatus));
  }, testDelay);

  testDelay += 1000;

  // Test 5: Invalid message type
  setTimeout(() => {
    const invalid = {
      type: 'invalid.type',
      payload: {},
      id: crypto.randomUUID(),
    };
    console.log('📤 Test 5: Invalid message type (should error)');
    ws.send(JSON.stringify(invalid));
  }, testDelay);

  testDelay += 2000;

  // Close after all tests
  setTimeout(() => {
    console.log('\n✅ Tests complete, closing connection...');
    ws.close();
  }, testDelay);
}

// Run the test
testWebSocket().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
