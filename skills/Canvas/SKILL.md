---
name: Canvas
description: |
  Bidirectional real-time communication between the Kaya agent and the Canvas web app.
  Renders containers (markdown, code, terminal, image, table) in the browser via JSON-RPC 2.0
  over the Kaya daemon WebSocket (port 18000). Streams LLM output progressively.
  USE WHEN: display in canvas, show visually, create a container, render in browser,
  stream to canvas, show markdown in canvas, canvas container, layout snapshot,
  canvas ping, canvas status.
version: "1.0.0"
phase: 6
---

# Canvas Skill

Establishes bidirectional real-time communication between the Kaya CLI agent and the Canvas
web app via JSON-RPC 2.0 over the Kaya daemon WebSocket (port 18000).

## USE WHEN

- User says "display in canvas" or "show visually" or "open in canvas"
- Streaming LLM output to a visual container in the browser
- Creating, updating, or deleting Canvas containers programmatically
- Taking or restoring layout snapshots
- Checking Canvas connection status (ping)

## Architecture

```
Kaya CLI Agent
  -> CanvasClient.ts (Bun WS)
  -> Daemon (port 18000, broadcasts all messages)
  -> Canvas web app (browser)
     -> ws-client.ts (Browser WS)
     -> rpc-handler.ts (JSON-RPC router)
     -> container-store (Zustand)
     -> DOM (React)
```

## Tools

| Tool | Purpose |
|------|---------|
| `CanvasClient.ts` | Agent-side Bun WS client for Canvas communication |
| `ChatListener.ts` | Persistent chat listener — receives user messages, routes slash commands, sends AI responses |
| `ContainerBuilder.ts` | AI layout builder: intent classification, content-type negotiation, tier selection, template-first pipeline |
| `LayoutIntelligence.ts` | Feedback learning system for layout preferences with confidence scoring and decay |
| `TemplateManager.ts` | Template CRUD with intent-based matching, built-in and user templates |

## Files

```
~/.claude/skills/Canvas/
  SKILL.md                          — This file
  Tools/
    CanvasClient.ts                 — Agent-side Bun WS client
    ChatListener.ts                 — Persistent chat listener (slash commands + AI inference)
    ContainerBuilder.ts             — AI orchestration: classify, negotiate, position, tier select
    LayoutIntelligence.ts           — Preference learning with confidence decay
    TemplateManager.ts              — Template CRUD with intent matching
  Config/
    container-registry.json         — Container type definitions and default props
    templates/                      — Built-in layout templates (read-only)
      morning-briefing.json
      data-dashboard.json
      code-review.json
  State/
    active-sessions.json            — Connected Canvas browser instances
    layout-preferences.json         — Learned layout preferences
    templates/                      — User-saved templates (mutable)

~/Desktop/projects/kaya-canvas/src/
  types/protocol.ts                 — JSON-RPC 2.0 types (shared protocol)
  lib/
    ws-client.ts                    — Browser WS client to daemon
    rpc-handler.ts                  — JSON-RPC method router to store actions
  stores/
    connection-store.ts             — Zustand store: connection status + actions
```

## CanvasClient API

```typescript
import { CanvasClient } from '~/.claude/skills/Canvas/Tools/CanvasClient.ts'

const client = new CanvasClient()
await client.connect()  // resolves when auth.success received

// Create a markdown container
const { id } = await client.createContainer({
  type: 'markdown',
  position: { x: 100, y: 100 },
  size: { width: 400, height: 300 },
  props: { content: '# Hello' },
})

// Stream content progressively
await client.streamToContainer(id, 'Hello ')
await client.streamToContainer(id, 'World', true)  // done=true = final chunk

// Update title or position
await client.updateContainer(id, { title: 'My Note' })

// Read current content
const { content } = await client.readContainer(id)

// Snapshot and restore layout
const snapshot = await client.snapshotLayout()
await client.applyLayout(snapshot.containers)

// Check latency
const { latency } = await client.ping()

// Listen for user interaction events
client.onContainerEvent((event) => {
  console.log(event.id, event.event, event.data)
})

// Delete
await client.deleteContainer(id)

// Cleanup
client.destroy()
```

## Container Types

Defined in `Config/container-registry.json`. Currently supported in Phase 1 UI:

| Type       | Streaming | Key Props |
|------------|-----------|-----------|
| `markdown` | Yes       | `content: string` |
| `code`     | Yes       | `code: string`, `language: string` |
| `terminal` | Yes       | `lines: string[]` |
| `image`    | No        | `src: string`, `alt: string`, `fit: 'fit'|'fill'|'cover'` |
| `table`    | No        | `columns: string[]`, `rows: object[]` |

Types `chart`, `form`, `list`, `custom` fall back to markdown rendering until implemented.

## Phase 4-6 Capabilities

### AI Orchestration (Phase 4)

- **ContainerBuilder**: Full layout build pipeline — classify intent, negotiate content types, consult preferences, generate positioned specs
- **LayoutIntelligence**: Learns user layout preferences with confidence scoring (0.3 initial, reinforcement, 14-day half-life decay)
- **Tier Selection**: 3-tier component resolution — registry (known components), declarative (form/list/detail/metric/status), sandpack (custom generation)

### Template System (Phase 5)

- **TemplateManager**: CRUD operations for layout templates with intent-based matching
- **Built-in Templates**: morning-briefing, data-dashboard, code-review (read-only)
- **User Templates**: Save, load, delete custom templates (State/templates/)
- **Template-First Pipeline**: `buildLayout()` checks templates before classify/build pipeline

### Canvas UI Features (Phase 6)

- **Dark mode support** with system preference detection
- **Keyboard shortcuts**: Cmd+N (new container), T (toggle theme), Z (undo), Shift+Z (redo), S (snapshot), Escape (deselect)
- **Undo/redo system** for layout operations
- **Error boundaries** per container for graceful failure isolation
- **Virtualization** for large layouts with many containers

## Protocol: JSON-RPC 2.0 over `canvas.rpc` WSMessage

All canvas communication is wrapped in a single `canvas.rpc` WSMessage type.
The daemon broadcasts it without interpretation. The Canvas app and CanvasClient
filter and route `canvas.rpc` messages.

```
Agent -> Daemon -> Canvas:
  { type: 'canvas.rpc', payload: { jsonrpc: '2.0', id: 1, method: 'canvas.container.create', params: { spec: {...} } } }

Canvas -> Daemon -> Agent:
  { type: 'canvas.rpc', payload: { jsonrpc: '2.0', id: 1, result: { id: '...', spec: {...} } } }

Canvas -> Agent (notification, no id):
  { type: 'canvas.rpc', payload: { jsonrpc: '2.0', method: 'canvas.container.event', params: { id: '...', event: 'click', data: {} } } }
```

## Error Codes

| Code    | Meaning |
|---------|---------|
| -32700  | Parse error — invalid JSON |
| -32600  | Invalid request |
| -32601  | Method not found |
| -32602  | Invalid params |
| -32603  | Internal error |
| -32000  | No Canvas clients connected to daemon |
| -32001  | Container not found |
| -32002  | Container type unknown |
| -32003  | Layout conflict |

## Reconnection Strategy

Both CanvasClient and ws-client auto-reconnect with exponential backoff:

```
Attempt 1: 1s delay
Attempt 2: 2s delay
Attempt 3: 4s delay
...
Max delay: 30s
Unlimited retries
```

## Voice Notification

When creating containers or starting streams, notify the user:
```bash
curl -X POST http://localhost:8888/notify \
  -H "Content-Type: application/json" \
  -d '{"message":"Created canvas container and started streaming content","voice_id":"iLVmqjzCGGvqtMCk6vVQ","title":"Canvas"}'
```

## CLI Usage

```bash
# Check connection
bun ~/.claude/skills/Canvas/Tools/CanvasClient.ts ping

# Create a markdown container
bun ~/.claude/skills/Canvas/Tools/CanvasClient.ts create markdown "# Hello from Kaya"

# Stream to existing container
bun ~/.claude/skills/Canvas/Tools/CanvasClient.ts stream <id> "Hello World"

# Delete container
bun ~/.claude/skills/Canvas/Tools/CanvasClient.ts delete <id>

# Snapshot current layout
bun ~/.claude/skills/Canvas/Tools/CanvasClient.ts snapshot

# Start persistent chat listener
bun ~/.claude/skills/Canvas/Tools/ChatListener.ts
# Or via CanvasClient alias:
bun ~/.claude/skills/Canvas/Tools/CanvasClient.ts listen

# Build a layout from intent
bun ~/.claude/skills/Canvas/Tools/ContainerBuilder.ts build "show me a dashboard"

# Classify an intent
bun ~/.claude/skills/Canvas/Tools/ContainerBuilder.ts classify "morning briefing"

# Negotiate data to container type
bun ~/.claude/skills/Canvas/Tools/ContainerBuilder.ts negotiate '{"data":[{"name":"A","status":"done"}]}'

# List templates
bun ~/.claude/skills/Canvas/Tools/TemplateManager.ts list

# Find best template for intent
bun ~/.claude/skills/Canvas/Tools/TemplateManager.ts find "morning"

# Save a user template
bun ~/.claude/skills/Canvas/Tools/TemplateManager.ts save "my-layout" --description "Custom layout"

# Consult layout preferences
bun ~/.claude/skills/Canvas/Tools/LayoutIntelligence.ts consult "dashboard"
```

## Integration Points

- Daemon WebSocket: `ws://localhost:18000` (port 18000, existing auth flow)
- Canvas frontend: `http://localhost:5173` (Vite dev server)
- Skill system: Called from other skills via `import { CanvasClient }`
- Container-store: Zustand store in Canvas app — updated by rpc-handler
- Connection-store: Zustand store in Canvas app — tracks WS state

## Workflow Routing

| Trigger | Action |
|---------|--------|
| "display X in canvas" | createContainer with type=markdown, content=X |
| "stream to canvas" | streamToContainer with LLM chunks |
| "close canvas container" | deleteContainer |
| "snapshot canvas" | snapshotLayout |
| "canvas status" | ping, check connection-store |
| "show me a dashboard" | buildLayout with template-first, then classify pipeline |
| "morning briefing in canvas" | Template match -> morning-briefing template layout |
| "save this layout" | TemplateManager save with current layout |
| "start canvas chat" | Launch ChatListener (`bun ChatListener.ts`) |
| "listen for canvas chat" | Launch ChatListener (`bun ChatListener.ts`) |

## Customization

- **Templates**: Add custom JSON templates to `State/templates/` or use `TemplateManager.ts save`
- **Container Registry**: Extend `Config/container-registry.json` with new container types and default props
- **Layout Preferences**: LayoutIntelligence learns from user rearrangements automatically
- **Tier Resolution**: Extend `REGISTRY_COMPONENTS` in ContainerBuilder.ts for new Tier 1 components

## Examples

```typescript
// Build a layout from natural language
import { buildLayout } from '~/.claude/skills/Canvas/Tools/ContainerBuilder.ts'
const result = await buildLayout({ intent: "show me a dashboard" })
// result.specs -> ContainerSpec[] ready for Canvas

// Use template system directly
import { createTemplateManager } from '~/.claude/skills/Canvas/Tools/TemplateManager.ts'
const tm = createTemplateManager()
const template = tm.findBestTemplate("morning briefing")
if (template) {
  // Use template.layout.containers for rendering
}

// Negotiate data shape to container type
import { negotiateContainerType } from '~/.claude/skills/Canvas/Tools/ContainerBuilder.ts'
const type = negotiateContainerType([{ name: "Task A", status: "done" }])
// type -> { type: "table", props: { columns: ["name", "status"], rows: [...] } }
```
