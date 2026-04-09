# Worker Thread Architecture Plan: Channel Isolation

## Problem

All channel connections (WhatsApp, Telegram, Discord, Slack, Gmail) run on the
main Node.js thread alongside the HTTP server (`/health`, `/api/chat`,
`/api/notifications`). WhatsApp/Baileys is the worst offender -- its Signal
protocol crypto (curve25519, AES-CBC, HMAC) and protobuf
serialization/deserialization block the event loop for tens of milliseconds at a
time. When multiple messages arrive simultaneously or during initial key
exchange, the HTTP server becomes unresponsive.

Telegram (grammy long-poll), Discord (discord.js WebSocket), and Slack (Bolt
socket mode) are lighter but still compete for event loop time during bursts.

## Architecture Overview

```
                         MAIN THREAD
  ┌─────────────────────────────────────────────────────────┐
  │                                                         │
  │  HTTP Server (:3000)                                    │
  │    /health  /api/chat  /api/notifications                │
  │                                                         │
  │  Platform Channel (virtual, in-process)                 │
  │                                                         │
  │  Message Loop (poll DB, enqueue to GroupQueue)           │
  │  GroupQueue -> runContainerAgent                        │
  │  Task Scheduler, IPC Watcher                            │
  │                                                         │
  │  ChannelProxy[] ──────── implements Channel interface    │
  │    ├─ WhatsAppProxy  ─── MessagePort ──┐                │
  │    ├─ TelegramProxy  ─── MessagePort ──┤                │
  │    ├─ DiscordProxy   ─── MessagePort ──┤                │
  │    ├─ SlackProxy     ─── MessagePort ──┤                │
  │    └─ GmailProxy     ─── MessagePort ──┘                │
  │                          │                              │
  └──────────────────────────│──────────────────────────────┘
                             │ MessagePort (structured clone)
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
  │ WORKER 1     │ │ WORKER 2     │ │ WORKER N     │
  │ (WhatsApp)   │ │ (Telegram)   │ │ (Gmail)      │
  │              │ │              │ │              │
  │ Real Channel │ │ Real Channel │ │ Real Channel │
  │ instance     │ │ instance     │ │ instance     │
  │              │ │              │ │              │
  │ Baileys sock │ │ grammy Bot   │ │ googleapis   │
  │ Signal proto │ │ long-poll    │ │ OAuth+poll   │
  │ crypto ops   │ │              │ │              │
  └──────────────┘ └──────────────┘ └──────────────┘
```

**Key insight**: Each channel gets its own Worker Thread with its own V8 isolate
and event loop. Crypto, protobuf, and network I/O in one channel cannot block
the main thread or other channels.

## Message Protocol (MessagePort)

All communication between main thread and workers uses `MessagePort` with a
typed message envelope:

```typescript
// src/channel-worker-protocol.ts

/** Main thread -> Worker */
export type MainToWorkerMessage =
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'send-message'; id: string; jid: string; text: string }
  | { type: 'set-typing'; jid: string; isTyping: boolean }
  | { type: 'sync-groups'; force: boolean; id: string }
  | { type: 'update-registered-groups'; groups: Record<string, RegisteredGroupData> };

/** Worker -> Main thread */
export type WorkerToMainMessage =
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'connection-error'; error: string }
  | { type: 'message'; chatJid: string; msg: NewMessageData }
  | { type: 'chat-metadata'; chatJid: string; timestamp: string; name?: string; channel?: string; isGroup?: boolean }
  | { type: 'send-message-result'; id: string; success: boolean; error?: string }
  | { type: 'sync-groups-result'; id: string }
  | { type: 'is-connected'; value: boolean }
  | { type: 'notification'; notificationType: 'info' | 'action' | 'error'; message: string }
  | { type: 'log'; level: string; msg: string; data?: Record<string, unknown> }
  | { type: 'pairing-code'; code: string };

// Serializable subset of RegisteredGroup (no functions)
export interface RegisteredGroupData {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  requiresTrigger?: boolean;
  isMain?: boolean;
}

// Serializable subset of NewMessage
export interface NewMessageData {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  thread_id?: string;
}
```

**Why structured clone, not JSON**: `MessagePort.postMessage()` uses the
structured clone algorithm which is faster than `JSON.stringify` +
`JSON.parse` for typical message payloads and avoids manual
serialization/deserialization.

## Files to Create

### 1. `src/channel-worker-protocol.ts` (NEW)
Shared type definitions for the MessagePort protocol. Imported by both the main
thread proxy and the worker entry point. Must contain only types and plain
serializable interfaces (no class instances, no functions).

### 2. `src/channel-worker.ts` (NEW)
Worker thread entry point. Receives channel name + config via `workerData`,
creates the real channel instance, and bridges it to the main thread via
`parentPort`.

```
workerData = {
  channelName: string;        // 'whatsapp' | 'telegram' | 'discord' | 'slack' | 'gmail'
  channelConfig: object;      // channel-specific config (tokens, env vars)
  registeredGroups: Record<string, RegisteredGroupData>;
}
```

Responsibilities:
- Import the specific channel class (NOT through the registry -- direct import)
- Create channelOpts that forward onMessage/onChatMetadata back to main via parentPort
- Call channel.connect(), post 'connected' or 'connection-error' back
- Listen for commands from main (send-message, set-typing, sync-groups, disconnect)
- Forward registeredGroups updates from main thread to the local closure
- Handle channel crashes: catch unhandled errors, post 'connection-error', attempt reconnect

### 3. `src/channel-proxy.ts` (NEW)
Main-thread proxy that implements the `Channel` interface. Each proxy wraps a
`Worker` instance and translates Channel method calls into MessagePort messages.

```typescript
export class ChannelProxy implements Channel {
  name: string;
  private worker: Worker;
  private connected = false;
  private pendingReplies = new Map<string, { resolve: Function; reject: Function }>();

  constructor(name: string, channelConfig: object, registeredGroups: Record<string, RegisteredGroupData>) { ... }

  async connect(): Promise<void> {
    // Spawn worker, send 'connect', wait for 'connected' or 'connection-error'
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Post 'send-message' with unique ID, await 'send-message-result'
  }

  isConnected(): boolean { return this.connected; }

  ownsJid(jid: string): boolean {
    // Determined by channel name, no need to cross thread boundary
    // whatsapp -> @g.us or @s.whatsapp.net
    // telegram -> tg:
    // discord  -> dc:
    // slack    -> slack:
    // gmail    -> gmail:
  }

  async disconnect(): Promise<void> {
    // Post 'disconnect', await 'disconnected', then worker.terminate()
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    // Fire-and-forget: post 'set-typing', don't await
  }

  async syncGroups(force: boolean): Promise<void> {
    // Post 'sync-groups' with unique ID, await 'sync-groups-result'
  }

  /** Push updated registeredGroups to worker (main thread calls this on changes) */
  updateRegisteredGroups(groups: Record<string, RegisteredGroupData>): void {
    this.worker.postMessage({ type: 'update-registered-groups', groups });
  }
}
```

## Files to Modify

### 4. `src/index.ts`
- Replace the current channel creation loop (lines 790-806) with ChannelProxy instantiation
- The `channelOpts.onMessage` and `channelOpts.onChatMetadata` callbacks remain
  on the main thread -- the proxy receives worker messages and calls them
- When `registeredGroups` changes (in `registerGroup()`), broadcast the update
  to all worker proxies
- Shutdown: call `proxy.disconnect()` for each, which terminates the workers
- The platform channel stays in-process (it's virtual, no I/O)

**Minimal diff approach**: The rest of `src/index.ts` should not change. The
`channels: Channel[]` array still holds Channel objects -- they're just
ChannelProxy instances instead of real channels. `findChannel()`,
`startMessageLoop()`, `processGroupMessages()`, etc. all work unchanged because
ChannelProxy implements the same Channel interface.

### 5. `src/channels/registry.ts`
- Add a new export: `getChannelConfig(name: string): object | null` that
  returns the serializable config for a channel (tokens, env vars) without
  creating the channel instance. Each channel's `registerChannel` call would
  also register a config extractor.
- Alternatively, keep registry as-is and have the proxy extract config from
  `process.env` directly (simpler, since env vars are inherited by workers).

**Recommendation**: Keep it simple. Workers inherit `process.env` from the main
process, so each channel's constructor in the worker can read its own env vars
just like it does today. No registry changes needed for MVP.

### 6. `src/channels/index.ts`
- No changes for MVP. The barrel import still registers channel factories, but
  they're only used to detect which channels have credentials (the
  `getRegisteredChannelNames()` check). The actual channel instances are created
  inside workers.
- Post-MVP: refactor to separate "credential check" from "channel creation" so
  the main thread never loads heavy dependencies (Baileys, discord.js, etc.).

### 7. `src/types.ts`
- No changes. The `Channel` interface stays the same. `ChannelProxy` implements
  it transparently.

## Channel Interface Bridge: Detailed Flow

### Inbound Message Flow (channel receives msg -> main thread)

```
  WORKER                              MAIN THREAD
  ──────                              ───────────
  Baileys fires                       ChannelProxy.onWorkerMessage()
  messages.upsert event                 │
       │                                │
  WhatsAppChannel.onMessage()           │
  (inside worker)                       │
       │                                │
  parentPort.postMessage({              │
    type: 'message',             ───>   receives 'message'
    chatJid, msg                        │
  })                                    calls channelOpts.onMessage(chatJid, msg)
                                        │
                                        storeMessage() in SQLite
                                        │
                                        startMessageLoop() picks it up
```

### Outbound Message Flow (main thread -> channel sends msg)

```
  MAIN THREAD                         WORKER
  ───────────                         ──────
  processGroupMessages()
    channel.sendMessage(jid, text)
       │
  ChannelProxy.sendMessage()
       │
  worker.postMessage({
    type: 'send-message',        ───>  receives 'send-message'
    id, jid, text                       │
  })                                    WhatsAppChannel.sendMessage(jid, text)
       │                                │
  await promise                         parentPort.postMessage({
       │                                  type: 'send-message-result',
  ChannelProxy resolves promise  <───    id, success: true
                                        })
```

### Typing Indicator Flow (fire-and-forget)

```
  MAIN THREAD                         WORKER
  ───────────                         ──────
  channel.setTyping(jid, true)
       │
  ChannelProxy.setTyping()
       │
  worker.postMessage({
    type: 'set-typing',          ───>  receives 'set-typing'
    jid, isTyping: true                 │
  })                                    WhatsAppChannel.setTyping(jid, true)
  (no await -- fire-and-forget)
```

## WhatsApp Pairing Code Across Threads

The pairing code flow is the trickiest part because it involves interactive
user feedback:

1. **Worker creates Baileys socket** with `printQRInTerminal: false`
2. **Worker detects `IS_RAILWAY && WHATSAPP_PHONE && !registered`** -> requests
   pairing code from Baileys
3. **Worker posts pairing code to main thread**:
   ```typescript
   parentPort.postMessage({
     type: 'notification',
     notificationType: 'action',
     message: `WhatsApp pairing code: **${code}**\n\nOpen WhatsApp -> ...`
   });
   ```
4. **Main thread ChannelProxy** receives the notification and calls
   `pushNotification()` (which is a main-thread-only module backed by an
   in-memory array)
5. **HTTP API** `/api/notifications` serves the notification to the Nova
   platform frontend -- user sees the code

This works because:
- `pushNotification()` is called on the main thread (in the proxy's message
  handler), not in the worker
- The notification system is already decoupled from the channel (WhatsApp
  currently does a dynamic `import('../notifications.js')` -- moving that to
  the proxy is cleaner)
- The pairing code is a simple string, fully structured-clone-able

**QR code flow** (local/non-Railway): Same approach. Worker detects QR, posts
a notification to the main thread. Main thread can display it via the existing
macOS osascript notification or push it to the HTTP API.

**Auth state persistence**: Baileys' `useMultiFileAuthState` reads/writes to
`STORE_DIR/auth/`. This works in a worker thread because file I/O is
process-wide. No changes needed. Workers inherit the same filesystem.

## Registered Groups Synchronization

The `registeredGroups` closure is the one piece of shared mutable state. Today,
channels access it via `channelOpts.registeredGroups()` (a function returning
the current object). In the worker model:

1. **Main thread** is the source of truth for `registeredGroups`
2. When `registerGroup()` is called, main thread broadcasts the full
   `registeredGroups` object to all workers:
   ```typescript
   for (const proxy of channelProxies) {
     proxy.updateRegisteredGroups(toSerializable(registeredGroups));
   }
   ```
3. **Worker** stores a local copy and uses it in
   `channelOpts.registeredGroups()`. Since only the main thread mutates groups,
   and updates are infrequent (startup + IPC commands), eventual consistency
   with a simple "replace entire object" broadcast is sufficient.

No locks, no shared memory. The worst case is a message arriving in the worker
between a group being registered on the main thread and the update reaching
the worker -- the message is dropped (same as the current race condition
before `registerGroup` completes).

## Edge Cases

### 1. Worker Crash / Unhandled Exception

```typescript
// In ChannelProxy constructor:
this.worker.on('error', (err) => {
  logger.error({ channel: this.name, err }, 'Channel worker crashed');
  this.connected = false;
  pushNotification('error', `${this.name} channel crashed: ${err.message}`);
  // Auto-restart after delay
  setTimeout(() => this.respawn(), 5000);
});

this.worker.on('exit', (code) => {
  if (code !== 0) {
    logger.warn({ channel: this.name, code }, 'Channel worker exited unexpectedly');
    this.connected = false;
    setTimeout(() => this.respawn(), 5000);
  }
});
```

The `respawn()` method creates a new Worker with the same config and calls
`connect()`. Pending `sendMessage` promises are rejected with a
"channel restarting" error so the GroupQueue can retry.

### 2. Channel Reconnection (WhatsApp disconnected by server)

WhatsApp's `connection.update` handler with `shouldReconnect` logic stays
inside the worker. Reconnection is transparent to the main thread -- the
worker's internal `connected` state toggles, outgoing messages queue inside
the worker's `outgoingQueue`, and the worker posts `connected`/`disconnected`
status updates to the main thread so `isConnected()` reflects reality.

```typescript
// Worker posts status changes:
parentPort.postMessage({ type: 'disconnected' });
// ... after reconnect ...
parentPort.postMessage({ type: 'connected' });
```

### 3. Graceful Shutdown

```typescript
// src/index.ts shutdown handler:
const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutdown signal received');
  proxyServer?.close();
  await queue.shutdown(10000);
  // Disconnect all channel workers (sends 'disconnect', awaits 'disconnected', terminates)
  await Promise.all(channels.map((ch) => ch.disconnect()));
  process.exit(0);
};
```

Each `ChannelProxy.disconnect()`:
1. Posts `{ type: 'disconnect' }` to worker
2. Worker calls real `channel.disconnect()`, posts `{ type: 'disconnected' }`
3. Proxy calls `worker.terminate()` after receiving 'disconnected' or after a
   5-second timeout (whichever comes first)

### 4. Message Ordering

Messages from a single channel are guaranteed to arrive in order because a
single MessagePort is a FIFO queue. Messages from different channels may
interleave, but that's already the case today (channels fire onMessage
independently).

### 5. Memory: Avoiding Duplicate Module Loading

Each worker loads its own copy of the channel module (Baileys, discord.js,
etc.) in a separate V8 isolate. This means higher total memory usage. Mitigation:

- Only spawn workers for channels that have credentials (same check as today)
- WhatsApp/Baileys is ~50MB RSS -- isolating it is worth the memory cost
- Lighter channels (Telegram/Grammy ~15MB, Gmail ~10MB) could optionally stay
  on the main thread if memory is a concern. Make this configurable:
  ```
  CHANNEL_WORKER_MODE=all|heavy|none  (default: heavy)
  # 'all'   = every channel in its own worker
  # 'heavy' = only whatsapp + discord in workers, rest on main thread
  # 'none'  = current behavior (everything on main thread)
  ```

### 6. Logging

Workers cannot share the main thread's pino logger instance (it writes to
stdout which is shared, but logger state like child bindings is per-isolate).

Options:
- **Simple (MVP)**: Worker creates its own pino logger with a `channel` field.
  Both main thread and worker write to stdout. pino's JSON lines are atomic
  enough that interleaving is fine.
- **Clean**: Worker posts log messages to main thread, main thread logs them.
  Adds latency to logging, not worth it.

**Recommendation**: Each worker creates its own logger. Add a `worker: true`
field so logs can be filtered.

### 7. SQLite Access from Workers

The current `db.ts` uses `better-sqlite3` which is synchronous. `storeMessage()`
and `storeChatMetadata()` are called from `channelOpts.onMessage` and
`channelOpts.onChatMetadata` -- which in the worker model are called on the
MAIN THREAD (the proxy receives the message from the worker and calls the
callback). So there is no SQLite-from-worker issue. The database is only ever
accessed from the main thread.

### 8. `process.env` Changes at Runtime

If env vars change after worker startup (unlikely in this codebase), workers
won't see them. Not a concern today since all config is read at startup.

### 9. WhatsApp Auth Directory Locking

Baileys writes to `STORE_DIR/auth/` using `useMultiFileAuthState`. Since only
one WhatsApp worker exists, there's no contention. If someone accidentally
spawns two WhatsApp workers, Baileys would corrupt the auth state. The proxy
layer should enforce one-worker-per-channel-name.

## Implementation Order

### Phase 1: Protocol + Worker Entry Point
1. Create `src/channel-worker-protocol.ts` with message types
2. Create `src/channel-worker.ts` with the generic worker entry point
3. Unit test: spawn a worker, send connect/disconnect, verify messages flow

### Phase 2: Channel Proxy
4. Create `src/channel-proxy.ts` implementing `Channel` interface
5. Add `ownsJid` mapping (hardcoded per channel name, no cross-thread call)
6. Add request/response matching for `sendMessage` and `syncGroups`
7. Add worker crash detection and respawn logic

### Phase 3: Integration
8. Modify `src/index.ts` channel creation loop to use `ChannelProxy`
9. Add `registeredGroups` broadcast on group registration
10. Move notification forwarding from worker to main thread proxy
11. Test with WhatsApp (the primary motivator)

### Phase 4: Hardening
12. Add `CHANNEL_WORKER_MODE` config for selective worker isolation
13. Add health monitoring: if a worker stops posting heartbeats, respawn it
14. Add metrics: message latency through the proxy vs direct

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Higher memory usage (~50-100MB more) | Railway costs | `CHANNEL_WORKER_MODE=heavy` -- only isolate WhatsApp + Discord |
| MessagePort serialization overhead | Slight latency | Negligible for chat messages (< 1ms for structured clone of small objects) |
| Debugging harder (stack traces span threads) | Dev experience | Worker logs include `worker: true, channel: 'whatsapp'` for filtering |
| Baileys internals assume main thread | Breakage | Baileys uses no `window`/DOM APIs; tested in worker_threads by others |
| `discord.js` in worker thread | Potential issues | discord.js uses `ws` (WebSocket) which works in workers; no known issues |
| `@slack/bolt` socket mode in worker | Potential issues | Bolt uses `@slack/socket-mode` which is pure WebSocket; should work |

## Non-Goals (for this plan)

- **SharedArrayBuffer / Atomics**: Overkill. MessagePort is sufficient for the
  message volumes we handle (< 100 msgs/sec across all channels).
- **Cluster mode**: Different problem. We want thread isolation, not process
  replication.
- **Moving SQLite to a worker**: SQLite access is already fast (synchronous,
  in-process). The bottleneck is channel I/O, not DB.
- **Moving the agent runner to workers**: Container spawning (`runContainerAgent`)
  is already non-blocking (child_process.spawn). Not a bottleneck.
