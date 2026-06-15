---
name: chat-admin
description: Manage which chats Nova participates in — add (register) a new WhatsApp group or DM, Telegram, Slack, or Discord chat so Nova responds there; list the chats Nova is in; find unregistered chats to add; or stop/remove a chat. Owner/main only. Triggers — "add this group", "make Nova respond in X", "join the family chat", "what chats are you in", "stop responding in X", "remove this group".
---

# Chat Admin

Manage the chats Nova is registered in. A "chat" here is **any conversation on
any channel** — a WhatsApp group *or* a 1:1 DM, Telegram, Slack, Discord, or the
web chat — each keyed by its JID and given its own folder, memory, and gating.
These are **owner/main-only** operations.

Source of truth: the SQLite `registered_groups` table in `/data/store/messages.db`.

## Add (register) a chat
Call the `register_group` tool (main group only):
- `jid` — the chat JID: `120363…@g.us` (WhatsApp group), `…@s.whatsapp.net` (WhatsApp DM), `tg:-100…`, `dc:…`, `slack:C…`
- `name` — display name
- `folder` — channel-prefixed, lowercase, hyphenated: `whatsapp_family-chat`, `telegram_dev-team`, `slack_engineering`
- `trigger` — e.g. `@Nova`

A newly registered chat inherits `gating.json`'s `default` (owner-only). To let
other people trigger Nova there, add an `allow` entry — see the **`gating`** skill.

## Find chats to add (unregistered)
The discoverable-chats snapshot (main only) is in the IPC dir:
```bash
cat "$NANOCLAW_IPC_DIR/available_groups.json"
```
Each entry: `jid`, `name`, `lastActivity`, `isRegistered`. The list syncs daily;
to force a refresh, drop a task file and re-read:
```bash
echo '{"type":"refresh_groups"}' > "$NANOCLAW_IPC_DIR/tasks/refresh_$(date +%s).json"
```

## List registered chats
```bash
node -e 'const db=require("/app/node_modules/better-sqlite3")("/data/store/messages.db",{readonly:true});
for (const r of db.prepare("SELECT jid,name,folder,is_main FROM registered_groups").all())
  console.log(r.jid,"|",r.name,"|",r.folder, r.is_main?"(main)":"");'
```

## Stop / remove a chat
Two levels:

**Stop responding (immediate, recommended)** — set the chat's gating `mode` to
`"drop"` so Nova ignores it from the next poll. No restart. See the `gating` skill.

**Fully unregister (needs a redeploy)** — delete the row. ⚠️ The running process
keeps its registry in memory and only reloads on restart, so a raw delete does
**not** take effect until Nova redeploys:
```bash
node -e 'const db=require("/app/node_modules/better-sqlite3")("/data/store/messages.db");
console.log("removed:", db.prepare("DELETE FROM registered_groups WHERE jid=?").run(process.argv[1]).changes);' "<jid>"
```
Then redeploy (see the `self-management` skill). The chat's folder/files and
message history are left in place. For most "remove this group" requests, prefer
the `drop`-mode approach — it's live and reversible.
