/**
 * Worker Thread entry point for channel isolation.
 *
 * When spawned by ChannelProxy, this script:
 *  1. Reads workerData.channelName to determine which channel to create
 *  2. Imports all channel factories via the barrel file (triggers registrations)
 *  3. Creates channel opts that forward onMessage / onChatMetadata to parentPort
 *  4. Creates the channel instance and calls connect()
 *  5. Posts 'connected' or 'connection-error' back to the main thread
 *  6. Listens for commands from the main thread and dispatches them to the channel
 */

import { parentPort, workerData } from 'node:worker_threads';
import pino from 'pino';

import type {
  ChannelWorkerData,
  MainToWorkerMessage,
  WorkerToMainMessage,
  RegisteredGroupData,
} from './channel-worker-protocol.js';
import type { Channel, RegisteredGroup } from './types.js';

// Import the barrel file — this triggers every channel's registerChannel() call
import './channels/index.js';
import { getChannelFactory } from './channels/registry.js';

// ---------------------------------------------------------------------------
// Safety checks
// ---------------------------------------------------------------------------

if (!parentPort) {
  throw new Error('channel-worker.ts must be run inside a Worker thread');
}

const data = workerData as ChannelWorkerData;
if (!data?.channelName) {
  throw new Error('workerData.channelName is required');
}

// ---------------------------------------------------------------------------
// Worker-local logger (writes to stdout like the main thread; tagged for filtering)
// ---------------------------------------------------------------------------

const log = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
}).child({ worker: true, channel: data.channelName });

// ---------------------------------------------------------------------------
// Helper: post a typed message to the main thread
// ---------------------------------------------------------------------------

const port = parentPort!;

function postToMain(msg: WorkerToMainMessage): void {
  port.postMessage(msg);
}

// ---------------------------------------------------------------------------
// Registered groups — kept in sync with main thread broadcasts
// ---------------------------------------------------------------------------

let registeredGroups: Record<string, RegisteredGroupData> =
  data.registeredGroups ?? {};

/**
 * Convert serializable RegisteredGroupData back to the RegisteredGroup shape
 * that channel constructors expect from the `registeredGroups()` callback.
 * The full RegisteredGroup has an optional `containerConfig` that channels
 * never use, so we can safely cast the serializable subset.
 */
function getRegisteredGroups(): Record<string, RegisteredGroup> {
  return registeredGroups as unknown as Record<string, RegisteredGroup>;
}

// ---------------------------------------------------------------------------
// Create the channel
// ---------------------------------------------------------------------------

const factory = getChannelFactory(data.channelName);
if (!factory) {
  const err = `No factory registered for channel "${data.channelName}"`;
  log.error(err);
  postToMain({ type: 'connection-error', error: err });
  process.exit(1);
}

const channel: Channel | null = factory({
  onMessage(chatJid, msg) {
    postToMain({
      type: 'message',
      chatJid,
      msg: {
        id: msg.id,
        chat_jid: msg.chat_jid,
        sender: msg.sender,
        sender_name: msg.sender_name,
        content: msg.content,
        timestamp: msg.timestamp,
        is_from_me: msg.is_from_me,
        is_bot_message: msg.is_bot_message,
        thread_id: msg.thread_id,
      },
    });
  },
  onChatMetadata(chatJid, timestamp, name, channelName, isGroup) {
    postToMain({
      type: 'chat-metadata',
      chatJid,
      timestamp,
      name,
      channel: channelName,
      isGroup,
    });
  },
  registeredGroups: getRegisteredGroups,
});

if (!channel) {
  const msg = `Channel factory for "${data.channelName}" returned null (missing credentials?)`;
  log.warn(msg);
  postToMain({ type: 'connection-error', error: msg });
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Connect the channel
// ---------------------------------------------------------------------------

async function connectChannel(): Promise<void> {
  try {
    log.info('Connecting channel…');
    await channel!.connect();
    log.info('Channel connected');
    postToMain({ type: 'connected' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Channel connection failed');
    postToMain({ type: 'connection-error', error: message });
  }
}

// ---------------------------------------------------------------------------
// Listen for commands from the main thread
// ---------------------------------------------------------------------------

port.on('message', async (msg: MainToWorkerMessage) => {
  switch (msg.type) {
    case 'send-message': {
      try {
        await channel!.sendMessage(msg.jid, msg.text);
        postToMain({ type: 'send-message-result', id: msg.id, success: true });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.error({ err, jid: msg.jid }, 'sendMessage failed');
        postToMain({
          type: 'send-message-result',
          id: msg.id,
          success: false,
          error,
        });
      }
      break;
    }

    case 'send-image': {
      try {
        await channel!.sendImage(msg.jid, msg.imageBase64, msg.mimeType, msg.caption);
        postToMain({ type: 'send-image-result', id: msg.id, success: true });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.error({ err, jid: msg.jid }, 'sendImage failed');
        postToMain({
          type: 'send-image-result',
          id: msg.id,
          success: false,
          error,
        });
      }
      break;
    }

    case 'set-typing': {
      if (channel!.setTyping) {
        channel!.setTyping(msg.jid, msg.isTyping).catch((err) => {
          log.debug({ err, jid: msg.jid }, 'setTyping failed');
        });
      }
      break;
    }

    case 'sync-groups': {
      try {
        if (channel!.syncGroups) {
          await channel!.syncGroups(msg.force);
        }
        postToMain({ type: 'sync-groups-result', id: msg.id });
      } catch (err) {
        log.error({ err }, 'syncGroups failed');
        postToMain({ type: 'sync-groups-result', id: msg.id });
      }
      break;
    }

    case 'update-registered-groups': {
      registeredGroups = msg.groups;
      log.debug(
        { count: Object.keys(registeredGroups).length },
        'Registered groups updated',
      );
      break;
    }

    case 'retry-pairing': {
      // WhatsApp-specific: call retryPairing() if the channel exposes it
      const ch = channel as Channel & { retryPairing?: () => Promise<void> };
      if (typeof ch.retryPairing === 'function') {
        log.info('Retrying pairing…');
        ch.retryPairing().catch((err) => {
          const error = err instanceof Error ? err.message : String(err);
          log.error({ err }, 'retryPairing failed');
          postToMain({ type: 'connection-error', error });
        });
      } else {
        log.warn('retry-pairing received but channel does not support it');
      }
      break;
    }

    case 'disconnect': {
      try {
        await channel!.disconnect();
      } catch (err) {
        log.warn({ err }, 'disconnect threw (non-fatal)');
      }
      postToMain({ type: 'disconnected' });
      break;
    }

    default: {
      log.warn({ msg }, 'Unknown message type from main thread');
    }
  }
});

// ---------------------------------------------------------------------------
// Uncaught error handling — report to main thread instead of crashing silently
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'Uncaught exception in channel worker');
  postToMain({
    type: 'connection-error',
    error: `Worker uncaught exception: ${err instanceof Error ? err.message : String(err)}`,
  });
});

process.on('unhandledRejection', (reason) => {
  log.error({ err: reason }, 'Unhandled rejection in channel worker');
  postToMain({
    type: 'connection-error',
    error: `Worker unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

connectChannel();
