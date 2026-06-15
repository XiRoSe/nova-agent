---
name: gating
description: Control who can trigger Nova in a chat and how — the per-chat sender allowlist (which people may trigger Nova), the trigger keyword/regex, and the mode (require a trigger word / respond to everything / ignore the chat). Edits gating.json. Triggers — "only let X trigger you in this group", "allow @person in the family chat", "respond to everything here", "stop responding in this chat", "change my trigger word here", "who can talk to you in X".
---

# Gating (access control)

Controls, per chat, whether an incoming message wakes Nova. Enforced host-side on
every poll from `/data/data/gating.json` (on the persistent volume) — edits take
effect within ~2s, **no redeploy**. The owner's own messages (`is_from_me`)
always pass, regardless of the allowlist. Only change gating when the **owner**
asks.

## The file: `/data/data/gating.json`
```json
{
  "default": { "allow": [], "mode": "trigger", "triggerRegex": "^@Nova\\b" },
  "chats": {
    "<chat-jid>": { "allow": ["<sender-jid>"], "mode": "trigger", "triggerRegex": "^@Nova\\b" }
  },
  "logDenied": true
}
```
- **`allow`** — `"*"` (anyone) or an array of **exact sender JIDs**. `[]` = nobody but the owner. Use the JID exactly as the channel delivers it (it may be a `@lid` or `@s.whatsapp.net` id — copy it from the `messages` table, don't guess).
- **`mode`**:
  - `trigger` (default) — message must match `triggerRegex` **and** come from an allowed sender (or the owner)
  - `always` — any message from an allowed sender wakes Nova (no keyword)
  - `drop` — ignore the chat entirely (messages discarded at ingestion)
- **`triggerRegex`** — case-insensitive regex the message must match in `trigger` mode. Omit to use the built-in `@Nova`.
- A chat uses its `chats[<jid>]` entry if present, else `default`. Missing/invalid file → fail-closed (owner only).

## Find a sender's JID (to allowlist them)
```bash
node -e 'const db=require("/app/node_modules/better-sqlite3")("/data/store/messages.db",{readonly:true});
for (const r of db.prepare("SELECT DISTINCT sender,sender_name FROM messages WHERE chat_jid=?").all(process.argv[1]))
  console.log(r.sender,"|",r.sender_name);' "<chat-jid>"
```

## Edit safely (read–modify–write)
```bash
node -e 'const fs=require("fs"),p="/data/data/gating.json";
const c=JSON.parse(fs.readFileSync(p,"utf8")); c.chats=c.chats||{};
c.chats["<chat-jid>"]={allow:["<sender-jid>","<sender-jid-2>"],mode:"trigger"};
fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n");
console.log("updated:",Object.keys(c.chats));'
```

## Common requests → change
- **Allow specific people in a WhatsApp group** (main use): find their JIDs above, set `chats[jid].allow` to that list, `mode: "trigger"`.
- **Respond to everything in a chat** (no keyword): set that chat's `mode` to `"always"`.
- **Stop responding in a chat**: set its `mode` to `"drop"`.
- **Change the trigger word for a chat**: set its `triggerRegex` (e.g. `"^@assistant\\b"`).

Never set `default.allow` to `"*"` unless the owner explicitly wants Nova to
respond to everyone in every chat — the default is intentionally owner-only.
