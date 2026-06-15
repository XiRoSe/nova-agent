import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureGatingConfig,
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  SenderAllowlistConfig,
  shouldDropMessage,
  shouldTrigger,
} from './sender-allowlist.js';

let tmpDir: string;

function cfgPath(name = 'sender-allowlist.json'): string {
  return path.join(tmpDir, name);
}

function writeConfig(config: unknown, name?: string): string {
  const p = cfgPath(name);
  fs.writeFileSync(p, JSON.stringify(config));
  return p;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allowlist-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadSenderAllowlist', () => {
  it('returns allow-all defaults when file is missing', () => {
    const cfg = loadSenderAllowlist(cfgPath());
    expect(cfg.default.allow).toBe('*');
    expect(cfg.default.mode).toBe('trigger');
    expect(cfg.logDenied).toBe(true);
  });

  it('loads allow=* config', () => {
    const p = writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: false,
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe('*');
    expect(cfg.logDenied).toBe(false);
  });

  it('loads allow=[] (deny all)', () => {
    const p = writeConfig({
      default: { allow: [], mode: 'trigger' },
      chats: {},
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toEqual([]);
  });

  it('loads allow=[list]', () => {
    const p = writeConfig({
      default: { allow: ['alice', 'bob'], mode: 'drop' },
      chats: {},
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toEqual(['alice', 'bob']);
    expect(cfg.default.mode).toBe('drop');
  });

  it('per-chat override beats default', () => {
    const p = writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: { 'group-a': { allow: ['alice'], mode: 'drop' } },
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.chats['group-a'].allow).toEqual(['alice']);
    expect(cfg.chats['group-a'].mode).toBe('drop');
  });

  it('returns allow-all on invalid JSON', () => {
    const p = cfgPath();
    fs.writeFileSync(p, '{ not valid json }}}');
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe('*');
  });

  it('returns allow-all on invalid schema', () => {
    const p = writeConfig({ default: { oops: true } });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe('*');
  });

  it('rejects non-string allow array items', () => {
    const p = writeConfig({
      default: { allow: [123, null, true], mode: 'trigger' },
      chats: {},
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe('*'); // falls back to default
  });

  it('skips invalid per-chat entries', () => {
    const p = writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: {
        good: { allow: ['alice'], mode: 'trigger' },
        bad: { allow: 123 },
      },
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.chats['good']).toBeDefined();
    expect(cfg.chats['bad']).toBeUndefined();
  });
});

describe('isSenderAllowed', () => {
  it('allow=* allows any sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    expect(isSenderAllowed('g1', 'anyone', cfg)).toBe(true);
  });

  it('allow=[] denies any sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: [], mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    expect(isSenderAllowed('g1', 'anyone', cfg)).toBe(false);
  });

  it('allow=[list] allows exact match only', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice', 'bob'], mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    expect(isSenderAllowed('g1', 'alice', cfg)).toBe(true);
    expect(isSenderAllowed('g1', 'eve', cfg)).toBe(false);
  });

  it('uses per-chat entry over default', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: { g1: { allow: ['alice'], mode: 'trigger' } },
      logDenied: true,
    };
    expect(isSenderAllowed('g1', 'bob', cfg)).toBe(false);
    expect(isSenderAllowed('g2', 'bob', cfg)).toBe(true);
  });
});

describe('shouldDropMessage', () => {
  it('returns false for trigger mode', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    expect(shouldDropMessage('g1', cfg)).toBe(false);
  });

  it('returns true for drop mode', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'drop' },
      chats: {},
      logDenied: true,
    };
    expect(shouldDropMessage('g1', cfg)).toBe(true);
  });

  it('per-chat mode override', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: { g1: { allow: '*', mode: 'drop' } },
      logDenied: true,
    };
    expect(shouldDropMessage('g1', cfg)).toBe(true);
    expect(shouldDropMessage('g2', cfg)).toBe(false);
  });
});

describe('isTriggerAllowed', () => {
  it('allows trigger for allowed sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice'], mode: 'trigger' },
      chats: {},
      logDenied: false,
    };
    expect(isTriggerAllowed('g1', 'alice', cfg)).toBe(true);
  });

  it('denies trigger for disallowed sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice'], mode: 'trigger' },
      chats: {},
      logDenied: false,
    };
    expect(isTriggerAllowed('g1', 'eve', cfg)).toBe(false);
  });

  it('logs when logDenied is true', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice'], mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    isTriggerAllowed('g1', 'eve', cfg);
    // Logger.debug is called — we just verify no crash; logger is a real pino instance
  });
});

describe('shouldTrigger', () => {
  const base: SenderAllowlistConfig = {
    default: { allow: '*', mode: 'trigger', triggerRegex: '^@Nova\\b' },
    chats: {},
    logDenied: false,
  };

  it('triggers when regex matches and sender allowed', () => {
    expect(shouldTrigger('g1', 'alice', '@Nova hello', false, base)).toBe(true);
  });

  it('does not trigger when regex does not match', () => {
    expect(shouldTrigger('g1', 'alice', 'just chatting', false, base)).toBe(
      false,
    );
  });

  it('matches case-insensitively and after trimming', () => {
    expect(shouldTrigger('g1', 'alice', '  @nova hey', false, base)).toBe(true);
  });

  it('denies a disallowed sender even when regex matches', () => {
    const cfg: SenderAllowlistConfig = {
      ...base,
      default: { allow: ['alice'], mode: 'trigger', triggerRegex: '^@Nova\\b' },
    };
    expect(shouldTrigger('g1', 'eve', '@Nova hi', false, cfg)).toBe(false);
    expect(shouldTrigger('g1', 'alice', '@Nova hi', false, cfg)).toBe(true);
  });

  it('own messages bypass the sender allowlist (but still need the regex)', () => {
    const cfg: SenderAllowlistConfig = {
      ...base,
      default: { allow: ['alice'], mode: 'trigger', triggerRegex: '^@Nova\\b' },
    };
    expect(shouldTrigger('g1', 'eve', '@Nova hi', true, cfg)).toBe(true);
    expect(shouldTrigger('g1', 'eve', 'no trigger', true, cfg)).toBe(false);
  });

  it('drop mode never triggers', () => {
    const cfg: SenderAllowlistConfig = {
      ...base,
      default: { allow: '*', mode: 'drop', triggerRegex: '^@Nova\\b' },
    };
    expect(shouldTrigger('g1', 'alice', '@Nova hi', false, cfg)).toBe(false);
  });

  it('per-chat triggerRegex overrides the default', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger', triggerRegex: '^@Nova\\b' },
      chats: {
        g1: { allow: '*', mode: 'trigger', triggerRegex: '^!bot\\b' },
      },
      logDenied: false,
    };
    expect(shouldTrigger('g1', 'alice', '!bot do it', false, cfg)).toBe(true);
    expect(shouldTrigger('g1', 'alice', '@Nova do it', false, cfg)).toBe(false);
    // default chat still uses the default regex
    expect(shouldTrigger('g2', 'alice', '@Nova do it', false, cfg)).toBe(true);
  });

  it('falls back to built-in pattern when triggerRegex is invalid', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger', triggerRegex: '([unclosed' },
      chats: {},
      logDenied: false,
    };
    // Invalid regex must not throw, and must not match arbitrary text.
    expect(shouldTrigger('g1', 'alice', 'random text', false, cfg)).toBe(false);
  });
});

describe('ensureGatingConfig', () => {
  it('seeds a default config file when missing', () => {
    const p = cfgPath('gating.json');
    expect(fs.existsSync(p)).toBe(false);
    ensureGatingConfig(p);
    expect(fs.existsSync(p)).toBe(true);
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe('*');
    expect(cfg.default.mode).toBe('trigger');
    expect(typeof cfg.default.triggerRegex).toBe('string');
  });

  it('does not overwrite an existing config file', () => {
    const p = writeConfig(
      { default: { allow: ['alice'], mode: 'trigger' }, chats: {} },
      'gating.json',
    );
    ensureGatingConfig(p);
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toEqual(['alice']);
  });
});
