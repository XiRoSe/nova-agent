---
name: gmail
description: Read, search, send, and organize the user's Gmail (same Google connection as Calendar). Use to check, send, search, or reply to email.
---

# Skill: Gmail

## Description
Read, search, send, and organize the user's Gmail — on the **same per-user
Google connection** as Google Calendar (no separate setup). Read recent/important
mail, search, summarize, send and reply, mark read, archive, or trash.

## When to Use
- "check my email", "any new emails", "what's in my inbox", "search my mail for…"
- "send an email to…", "reply to…", "draft…"
- "mark as read / archive / delete that email"

## Always get a token first (same as Calendar)
```bash
RESP=$(curl -s "$NOVA_PLATFORM_URL/api/agent/google-token" -H "Authorization: Bearer $NOVA_AGENT_TOKEN")
ACCESS_TOKEN=$(echo "$RESP" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).token||'')}catch{console.log('')}})")
```
If `ACCESS_TOKEN` is empty → the user hasn't connected Google. Run the **Connecting**
flow in the `google-calendar` skill (it grants Calendar *and* Gmail in one go).
If the token exists but Gmail calls return 403 `insufficientPermissions`, the
connection predates Gmail access — tell them to reconnect Google (same flow).

## Operations (Gmail REST API — base `https://gmail.googleapis.com/gmail/v1/users/me`)

**List / search messages** (Gmail search syntax in `q`):
```bash
curl -s "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=is:unread" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
# -> { "messages": [ {"id":"...","threadId":"..."}, ... ] }
```

**Read one message** (headers + body). `format=full`; decode the base64url body:
```bash
ID=THE_MESSAGE_ID
curl -s "https://gmail.googleapis.com/gmail/v1/users/me/messages/$ID?format=full" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      const m=JSON.parse(s);
      const h=Object.fromEntries((m.payload.headers||[]).map(x=>[x.name,x.value]));
      const find=p=>{if(p.body&&p.body.data&&(p.mimeType||'').startsWith('text/plain'))return p.body.data;
                     for(const c of (p.parts||[])){const r=find(c);if(r)return r;} return null;};
      const data=find(m.payload)|| (m.payload.body&&m.payload.body.data);
      console.log('From:',h.From,'\nSubject:',h.Subject,'\nDate:',h.Date,'\n\n',
                  data?Buffer.from(data,'base64url').toString():'(no text body)');
    })"
```
For quick listings use `?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`.

**Send an email** (build a raw RFC-822 message, base64url-encode it):
```bash
RAW=$(node -e "
  const msg=[
    'To: someone@example.com',
    'Subject: Hello from Nova',
    'Content-Type: text/plain; charset=\"UTF-8\"',
    '', 'This is the body of the message.'
  ].join('\r\n');
  console.log(Buffer.from(msg).toString('base64url'));
")
curl -s -X POST "https://gmail.googleapis.com/gmail/v1/users/me/messages/send" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d "{\"raw\":\"$RAW\"}"
```
To **reply**, add `In-Reply-To:` and `References:` headers (the original Message-ID)
and pass `"threadId":"<thread>"` alongside `raw` so it threads.

**Mark read** (remove UNREAD) / **archive** (remove INBOX) / **trash**:
```bash
curl -s -X POST "https://gmail.googleapis.com/gmail/v1/users/me/messages/$ID/modify" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"removeLabelIds":["UNREAD"]}'        # archive: ["INBOX"]
curl -s -X POST "https://gmail.googleapis.com/gmail/v1/users/me/messages/$ID/trash" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

## Notes
- Never print the access token.
- **Confirm before sending, replying, or deleting** — show the user the draft/target first.
- Summarize inboxes concisely (sender · subject · 1-line gist); don't dump raw JSON.
- Default to the user's timezone for dates.
