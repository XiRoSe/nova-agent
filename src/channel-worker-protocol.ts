/**
 * Typed message protocol for communication between the main thread and
 * channel worker threads via MessagePort.
 *
 * This file contains ONLY types and interfaces — no runtime code, no imports
 * from other project modules. Both the main-thread proxy and worker entry
 * point import from here.
 */

// ---------------------------------------------------------------------------
// Serializable data interfaces (plain objects, no class instances or functions)
// ---------------------------------------------------------------------------

/** Serializable subset of RegisteredGroup (no ContainerConfig / functions). */
export interface RegisteredGroupData {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  requiresTrigger?: boolean;
  isMain?: boolean;
}

/** Serializable subset of NewMessage. */
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

/** Data passed to the worker via `workerData`. */
export interface ChannelWorkerData {
  channelName: string;
  registeredGroups: Record<string, RegisteredGroupData>;
}

// ---------------------------------------------------------------------------
// Main thread -> Worker messages
// ---------------------------------------------------------------------------

export type MainToWorkerMessage =
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'send-message'; id: string; jid: string; text: string }
  | { type: 'set-typing'; jid: string; isTyping: boolean }
  | { type: 'sync-groups'; force: boolean; id: string }
  | { type: 'update-registered-groups'; groups: Record<string, RegisteredGroupData> }
  | { type: 'retry-pairing' }
  | { type: 'send-image'; id: string; jid: string; imageBase64: string; mimeType: string; caption?: string };

// ---------------------------------------------------------------------------
// Worker -> Main thread messages
// ---------------------------------------------------------------------------

export type WorkerToMainMessage =
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'connection-error'; error: string }
  | { type: 'message'; chatJid: string; msg: NewMessageData }
  | {
      type: 'chat-metadata';
      chatJid: string;
      timestamp: string;
      name?: string;
      channel?: string;
      isGroup?: boolean;
    }
  | { type: 'send-message-result'; id: string; success: boolean; error?: string }
  | { type: 'sync-groups-result'; id: string }
  | {
      type: 'notification';
      notificationType: 'info' | 'action' | 'error';
      message: string;
    }
  | { type: 'log'; level: string; msg: string; data?: Record<string, unknown> }
  | { type: 'send-image-result'; id: string; success: boolean; error?: string };
