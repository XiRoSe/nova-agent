import fs from 'fs';
import path from 'path';

import { GATING_CONFIG_PATH, TRIGGER_PATTERN } from './config.js';
import { logger } from './logger.js';

export interface ChatAllowlistEntry {
  allow: '*' | string[];
  mode: 'trigger' | 'drop';
  // Optional per-chat trigger regex (source string, matched case-insensitively
  // against the trimmed message text). When omitted or invalid, the built-in
  // TRIGGER_PATTERN (derived from ASSISTANT_NAME) is used instead.
  triggerRegex?: string;
}

export interface SenderAllowlistConfig {
  default: ChatAllowlistEntry;
  chats: Record<string, ChatAllowlistEntry>;
  logDenied: boolean;
}

// Fail closed: when no config can be read, allow nobody by default. The owner
// still triggers via the is-from-me bypass in shouldTrigger(), so the system is
// never bricked — but a missing/corrupt config can never silently open the gate
// to every sender. Grant access explicitly by listing JIDs in gating.json.
const DEFAULT_CONFIG: SenderAllowlistConfig = {
  default: { allow: [], mode: 'trigger' },
  chats: {},
  logDenied: true,
};

function isValidEntry(entry: unknown): entry is ChatAllowlistEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  const validAllow =
    e.allow === '*' ||
    (Array.isArray(e.allow) && e.allow.every((v) => typeof v === 'string'));
  const validMode = e.mode === 'trigger' || e.mode === 'drop';
  const validRegex =
    e.triggerRegex === undefined || typeof e.triggerRegex === 'string';
  return validAllow && validMode && validRegex;
}

export function loadSenderAllowlist(
  pathOverride?: string,
): SenderAllowlistConfig {
  const filePath = pathOverride ?? GATING_CONFIG_PATH;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_CONFIG;
    logger.warn(
      { err, path: filePath },
      'sender-allowlist: cannot read config',
    );
    return DEFAULT_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn({ path: filePath }, 'sender-allowlist: invalid JSON');
    return DEFAULT_CONFIG;
  }

  const obj = parsed as Record<string, unknown>;

  if (!isValidEntry(obj.default)) {
    logger.warn(
      { path: filePath },
      'sender-allowlist: invalid or missing default entry',
    );
    return DEFAULT_CONFIG;
  }

  const chats: Record<string, ChatAllowlistEntry> = {};
  if (obj.chats && typeof obj.chats === 'object') {
    for (const [jid, entry] of Object.entries(
      obj.chats as Record<string, unknown>,
    )) {
      if (isValidEntry(entry)) {
        chats[jid] = entry;
      } else {
        logger.warn(
          { jid, path: filePath },
          'sender-allowlist: skipping invalid chat entry',
        );
      }
    }
  }

  return {
    default: obj.default as ChatAllowlistEntry,
    chats,
    logDenied: obj.logDenied !== false,
  };
}

function getEntry(
  chatJid: string,
  cfg: SenderAllowlistConfig,
): ChatAllowlistEntry {
  return cfg.chats[chatJid] ?? cfg.default;
}

export function isSenderAllowed(
  chatJid: string,
  sender: string,
  cfg: SenderAllowlistConfig,
): boolean {
  const entry = getEntry(chatJid, cfg);
  if (entry.allow === '*') return true;
  return entry.allow.includes(sender);
}

export function shouldDropMessage(
  chatJid: string,
  cfg: SenderAllowlistConfig,
): boolean {
  return getEntry(chatJid, cfg).mode === 'drop';
}

export function isTriggerAllowed(
  chatJid: string,
  sender: string,
  cfg: SenderAllowlistConfig,
): boolean {
  const allowed = isSenderAllowed(chatJid, sender, cfg);
  if (!allowed && cfg.logDenied) {
    logger.debug(
      { chatJid, sender },
      'sender-allowlist: trigger denied for sender',
    );
  }
  return allowed;
}

// Compiled-regex cache keyed by source string. Invalid sources resolve to the
// built-in TRIGGER_PATTERN (logged once per distinct bad source) so a typo in
// the config can never silently let everything through or block everything.
const regexCache = new Map<string, RegExp>();

function getTriggerRegex(entry: ChatAllowlistEntry): RegExp {
  const src = entry.triggerRegex;
  if (!src) return TRIGGER_PATTERN;
  const cached = regexCache.get(src);
  if (cached) return cached;
  try {
    const re = new RegExp(src, 'i');
    regexCache.set(src, re);
    return re;
  } catch {
    logger.warn(
      { triggerRegex: src },
      'gating: invalid triggerRegex, falling back to built-in TRIGGER_PATTERN',
    );
    regexCache.set(src, TRIGGER_PATTERN);
    return TRIGGER_PATTERN;
  }
}

// Single host-side gate: should this message wake the agent?
// True iff the chat is not in 'drop' mode AND the trigger regex matches the
// message text AND the sender is permitted (own messages always pass).
// This is the only trigger decision — it is never delegated to the agent.
export function shouldTrigger(
  chatJid: string,
  sender: string,
  content: string,
  isFromMe: boolean | undefined,
  cfg: SenderAllowlistConfig,
): boolean {
  const entry = getEntry(chatJid, cfg);
  if (entry.mode === 'drop') return false;
  if (!getTriggerRegex(entry).test(content.trim())) return false;
  if (isFromMe) return true;
  return isTriggerAllowed(chatJid, sender, cfg);
}

// Seed the gating config on the volume if it doesn't exist yet, so the file is
// always present and explicit (no silent fallback) and immediately editable at
// runtime. Seeds allow=[] (nobody but the owner, who passes via the is-from-me
// bypass) and triggerRegex with the current built-in pattern.
export function ensureGatingConfig(pathOverride?: string): void {
  const filePath = pathOverride ?? GATING_CONFIG_PATH;
  if (fs.existsSync(filePath)) return;
  const seed: SenderAllowlistConfig = {
    default: {
      allow: [],
      mode: 'trigger',
      triggerRegex: TRIGGER_PATTERN.source,
    },
    chats: {},
    logDenied: true,
  };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(seed, null, 2) + '\n');
    logger.info({ path: filePath }, 'gating: seeded default config');
  } catch (err) {
    logger.warn({ err, path: filePath }, 'gating: could not seed config');
  }
}
