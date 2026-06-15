# Skill: WhatsApp Message History

## Description
Query message history from any registered WhatsApp group or chat.

## When to Use
When asked to fetch, search, or summarize messages from a WhatsApp group or chat — e.g. "מה דיברו ב-X", "תשלפי הודעות מקבוצה Y מ-17:00".

## Database Access
- Path: `/data/store/messages.db` (SQLite, use readonly mode)
- Driver: `better-sqlite3` at `/app/node_modules/better-sqlite3`

```js
const db = require('/app/node_modules/better-sqlite3')('/data/store/messages.db', { readonly: true });
```

## Schema

### `chats` table
| column | type | notes |
|--------|------|-------|
| jid | TEXT | unique chat identifier |
| name | TEXT | display name |
| is_group | INTEGER | 1 = group |

### `messages` table
| column | type | notes |
|--------|------|-------|
| id | TEXT | |
| chat_jid | TEXT | FK → chats.jid |
| sender | TEXT | LID or JID |
| sender_name | TEXT | display name |
| content | TEXT | message text |
| timestamp | TEXT | ISO 8601 UTC |
| is_from_me | INTEGER | 1 = sent by Nova |
| is_bot_message | INTEGER | 1 = Nova's response |

## Common Queries

### Find a group by name
```js
const chat = db.prepare("SELECT * FROM chats WHERE name LIKE ?").get('%ספת הסאחים%');
```

### Fetch messages from a time window
```js
const msgs = db.prepare(`
  SELECT sender_name, content, timestamp
  FROM messages
  WHERE chat_jid = ? AND timestamp >= ? AND timestamp <= ?
  ORDER BY timestamp ASC
`).all(chat.jid, '2026-06-15T17:00:00.000Z', '2026-06-15T18:00:00.000Z');
```

### Fetch last N messages from a group
```js
const msgs = db.prepare(`
  SELECT sender_name, content, timestamp
  FROM messages
  WHERE chat_jid = ?
  ORDER BY timestamp DESC
  LIMIT 50
`).all(chat.jid);
```

## Notes
- All timestamps stored in UTC ISO 8601
- Convert user-specified local times to UTC before querying
- Format output as readable conversation: `[HH:MM] Name: content`
