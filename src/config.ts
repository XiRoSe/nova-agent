import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
// On Railway, secrets come from process.env (service config).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'SLACK_MAIN_CHANNEL_ID',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Railway deployment detection
export const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT;
export const RAILWAY_VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
export const MAIN_GROUP_FOLDER = 'main';
export const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
export const SLACK_MAIN_CHANNEL_ID =
  process.env.SLACK_MAIN_CHANNEL_ID || envConfig.SLACK_MAIN_CHANNEL_ID || '';

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = IS_RAILWAY
  ? path.join(RAILWAY_VOLUME, 'store')
  : path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = IS_RAILWAY
  ? path.join(RAILWAY_VOLUME, 'groups')
  : path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = IS_RAILWAY
  ? path.join(RAILWAY_VOLUME, 'data')
  : path.resolve(PROJECT_ROOT, 'data');

// Gating config (trigger regex + per-user allowlist) lives on the persistent
// volume so it survives redeploys and can be edited at runtime (by a human or
// the agent) without a code change or redeploy. Read directly by the host
// gating logic — never routed through the agent.
export const GATING_CONFIG_PATH = path.join(DATA_DIR, 'gating.json');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
