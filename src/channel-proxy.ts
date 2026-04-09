/**
 * Main-thread Channel proxy that wraps a Worker Thread.
 *
 * Implements the Channel interface so the rest of the codebase (message loop,
 * router, index.ts) can treat it exactly like a direct channel instance. Every
 * method call is translated into a typed MessagePort message, sent to the
 * worker, and (where applicable) the result is awaited via a pending-reply map.
 */

import { Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

import type { Channel, NewMessage } from './types.js';
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  RegisteredGroupData,
} from './channel-worker-protocol.js';
import { pushNotification } from './notifications.js';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Resolve the compiled worker script path (same directory, .js extension). */
const WORKER_SCRIPT = path.join(__dirname, 'channel-worker.js');

/** How long to wait before attempting to respawn a crashed worker (ms). */
const RESPAWN_DELAY_MS = 5000;

/** Timeout for connect / disconnect operations (ms). */
const LIFECYCLE_TIMEOUT_MS = 30_000;

/** Timeout for sendMessage / syncGroups request-response pairs (ms). */
const REQUEST_TIMEOUT_MS = 60_000;

interface PendingReply {
  resolve: (value?: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ChannelProxy implements Channel {
  readonly name: string;

  private worker: Worker | null = null;
  private _connected = false;
  private pendingReplies = new Map<string, PendingReply>();
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalShutdown = false;

  private readonly onMessage: (chatJid: string, msg: NewMessage) => void;
  private readonly onChatMetadata: (
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ) => void;
  private registeredGroups: Record<string, RegisteredGroupData>;

  constructor(
    channelName: string,
    onMessage: (chatJid: string, msg: NewMessage) => void,
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => void,
    registeredGroups: Record<string, RegisteredGroupData>,
  ) {
    this.name = channelName;
    this.onMessage = onMessage;
    this.onChatMetadata = onChatMetadata;
    this.registeredGroups = registeredGroups;
  }

  // ---------------------------------------------------------------------------
  // Channel interface
  // ---------------------------------------------------------------------------

  async connect(): Promise<void> {
    this.intentionalShutdown = false;
    this.spawnWorker();

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`${this.name} worker connect timed out after ${LIFECYCLE_TIMEOUT_MS}ms`));
      }, LIFECYCLE_TIMEOUT_MS);

      // Stash a one-shot listener key so the message handler can resolve/reject.
      const id = '__connect__';
      this.pendingReplies.set(id, {
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
        timer: timeout,
      });

      this.postToWorker({ type: 'connect' });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const id = crypto.randomUUID();

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(id);
        reject(new Error(`${this.name} sendMessage timed out (id=${id})`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingReplies.set(id, { resolve: () => { clearTimeout(timer); resolve(); }, reject: (err) => { clearTimeout(timer); reject(err); }, timer });
      this.postToWorker({ type: 'send-message', id, jid, text });
    });
  }

  isConnected(): boolean {
    return this._connected;
  }

  ownsJid(jid: string): boolean {
    switch (this.name) {
      case 'whatsapp':
        return jid.includes('@g.us') || jid.includes('@s.whatsapp.net');
      case 'telegram':
        return jid.startsWith('tg:');
      case 'discord':
        return jid.startsWith('dc:');
      case 'slack':
        return jid.startsWith('slack:');
      case 'gmail':
        return jid.startsWith('gmail:');
      default:
        return false;
    }
  }

  async disconnect(): Promise<void> {
    this.intentionalShutdown = true;

    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }

    if (!this.worker) {
      this._connected = false;
      return;
    }

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        // If the worker doesn't respond in time, force-terminate.
        logger.warn({ channel: this.name }, 'Worker did not acknowledge disconnect in time, terminating');
        this.terminateWorker();
        resolve();
      }, LIFECYCLE_TIMEOUT_MS);

      const id = '__disconnect__';
      this.pendingReplies.set(id, {
        resolve: () => {
          clearTimeout(timeout);
          this.terminateWorker();
          resolve();
        },
        reject: () => {
          clearTimeout(timeout);
          this.terminateWorker();
          resolve();
        },
        timer: timeout,
      });

      this.postToWorker({ type: 'disconnect' });
    });
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    // Fire-and-forget: don't await a response.
    this.postToWorker({ type: 'set-typing', jid, isTyping });
  }

  async syncGroups(force: boolean): Promise<void> {
    const id = crypto.randomUUID();

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(id);
        reject(new Error(`${this.name} syncGroups timed out (id=${id})`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingReplies.set(id, { resolve: () => { clearTimeout(timer); resolve(); }, reject: (err) => { clearTimeout(timer); reject(err); }, timer });
      this.postToWorker({ type: 'sync-groups', force, id });
    });
  }

  // ---------------------------------------------------------------------------
  // Extra methods (not part of Channel interface)
  // ---------------------------------------------------------------------------

  /** Push updated registeredGroups to the worker. */
  updateRegisteredGroups(groups: Record<string, RegisteredGroupData>): void {
    this.registeredGroups = groups;
    this.postToWorker({ type: 'update-registered-groups', groups });
  }

  /** Ask the worker to retry WhatsApp pairing (re-request a pairing code). */
  retryPairing(): void {
    this.postToWorker({ type: 'retry-pairing' });
  }

  // ---------------------------------------------------------------------------
  // Worker lifecycle
  // ---------------------------------------------------------------------------

  private spawnWorker(): void {
    if (this.worker) {
      logger.warn({ channel: this.name }, 'spawnWorker called while a worker already exists; terminating old worker');
      this.terminateWorker();
    }

    logger.info({ channel: this.name }, 'Spawning channel worker');

    this.worker = new Worker(WORKER_SCRIPT, {
      workerData: {
        channelName: this.name,
        registeredGroups: this.registeredGroups,
      },
    });

    this.worker.on('message', (msg: WorkerToMainMessage) => this.handleWorkerMessage(msg));

    this.worker.on('error', (err) => {
      logger.error({ channel: this.name, err }, 'Channel worker error');
      this._connected = false;
      this.rejectAllPending(new Error(`Worker error: ${err.message}`));
      pushNotification('error', `${this.name} channel worker error: ${err.message}`);
      this.scheduleRespawn();
    });

    this.worker.on('exit', (code) => {
      if (code !== 0 && !this.intentionalShutdown) {
        logger.warn({ channel: this.name, exitCode: code }, 'Channel worker exited unexpectedly');
        this._connected = false;
        this.rejectAllPending(new Error(`Worker exited with code ${code}`));
        this.scheduleRespawn();
      }
    });
  }

  private terminateWorker(): void {
    if (this.worker) {
      this.worker.removeAllListeners();
      this.worker.terminate().catch(() => {});
      this.worker = null;
    }
    this._connected = false;
    this.rejectAllPending(new Error('Worker terminated'));
  }

  private scheduleRespawn(): void {
    if (this.intentionalShutdown) return;
    if (this.respawnTimer) return; // already scheduled

    logger.info({ channel: this.name, delayMs: RESPAWN_DELAY_MS }, 'Scheduling worker respawn');
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      if (this.intentionalShutdown) return;
      this.respawn();
    }, RESPAWN_DELAY_MS);
  }

  private respawn(): void {
    logger.info({ channel: this.name }, 'Respawning channel worker');
    this.spawnWorker();
    this.postToWorker({ type: 'connect' });
    // No pending-reply tracking for auto-respawn connect; if it fails the error
    // handler will schedule another respawn.
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  private handleWorkerMessage(msg: WorkerToMainMessage): void {
    switch (msg.type) {
      case 'connected': {
        this._connected = true;
        logger.info({ channel: this.name }, 'Channel worker connected');
        const pending = this.pendingReplies.get('__connect__');
        if (pending) {
          this.pendingReplies.delete('__connect__');
          pending.resolve();
        }
        break;
      }

      case 'connection-error': {
        this._connected = false;
        logger.error({ channel: this.name, error: msg.error }, 'Channel worker connection error');
        const pending = this.pendingReplies.get('__connect__');
        if (pending) {
          this.pendingReplies.delete('__connect__');
          pending.reject(new Error(msg.error));
        }
        break;
      }

      case 'disconnected': {
        this._connected = false;
        logger.info({ channel: this.name }, 'Channel worker disconnected');
        const pending = this.pendingReplies.get('__disconnect__');
        if (pending) {
          this.pendingReplies.delete('__disconnect__');
          pending.resolve();
        }
        break;
      }

      case 'message': {
        // Translate NewMessageData (serializable) back to NewMessage (identical shape).
        this.onMessage(msg.chatJid, msg.msg as NewMessage);
        break;
      }

      case 'chat-metadata': {
        this.onChatMetadata(msg.chatJid, msg.timestamp, msg.name, msg.channel, msg.isGroup);
        break;
      }

      case 'send-message-result': {
        const pending = this.pendingReplies.get(msg.id);
        if (pending) {
          this.pendingReplies.delete(msg.id);
          if (msg.success) {
            pending.resolve();
          } else {
            pending.reject(new Error(msg.error ?? 'sendMessage failed'));
          }
        }
        break;
      }

      case 'sync-groups-result': {
        const pending = this.pendingReplies.get(msg.id);
        if (pending) {
          this.pendingReplies.delete(msg.id);
          pending.resolve();
        }
        break;
      }

      case 'notification': {
        pushNotification(msg.notificationType, msg.message);
        break;
      }

      case 'log': {
        const level = msg.level as 'info' | 'warn' | 'error' | 'debug' | 'trace' | 'fatal';
        const logFn = logger[level] ?? logger.info;
        logFn.call(logger, { channel: this.name, worker: true, ...msg.data }, msg.msg);
        break;
      }

      default: {
        // Exhaustiveness guard: log unknown message types.
        logger.warn({ channel: this.name, msg }, 'Unknown message type from channel worker');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Post a message to the worker, silently ignoring if worker is not alive. */
  private postToWorker(msg: MainToWorkerMessage): void {
    if (!this.worker) {
      logger.warn({ channel: this.name, msgType: msg.type }, 'Cannot post to worker: no worker');
      return;
    }
    try {
      this.worker.postMessage(msg);
    } catch (err) {
      logger.error({ channel: this.name, msgType: msg.type, err }, 'Failed to post message to worker');
    }
  }

  /** Reject all pending reply promises (e.g. on worker crash). */
  private rejectAllPending(reason: Error): void {
    for (const [id, pending] of this.pendingReplies) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pendingReplies.clear();
  }
}
