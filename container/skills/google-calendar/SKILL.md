# Skill: Google Calendar

## Description
Read and manage the user's Google Calendar — list upcoming events, check
availability (free/busy), and create, move, update, or delete events on their
behalf. Connecting happens **in chat** (any channel) — you walk the user
through it; nothing to do on a website.

## When to Use
- User asks "what's on my calendar", "am I free…", "when's my next meeting"
- User asks to schedule / book / add / move / reschedule / cancel an event
- User says "connect my (Google) calendar" → run the **Connecting** flow below

## Always check connection first
Before any calendar action, get a token:
```bash
RESP=$(curl -s "$NOVA_PLATFORM_URL/api/agent/google-token" -H "Authorization: Bearer $NOVA_AGENT_TOKEN")
ACCESS_TOKEN=$(echo "$RESP" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).token||'')}catch{console.log('')}})")
```
If `ACCESS_TOKEN` is non-empty → connected, go straight to the operation.
If empty → not connected; offer to connect and run the flow below.

## Connecting (first time) — do this conversationally, step by step
Keep it friendly and simple; one step at a time. The user uses their **own**
Google app so there's no Google approval/verification needed.

1. **Get the redirect URI to give them:**
   ```bash
   curl -s "$NOVA_PLATFORM_URL/api/agent/google-callback-url" -H "Authorization: Bearer $NOVA_AGENT_TOKEN"
   ```
   Tell the user (plainly):
   > "To connect your Google Calendar (takes ~2 min, and no Google approval needed because it's your own app):
   > 1. Go to **console.cloud.google.com** → APIs & Services → **Credentials** → **Create credentials → OAuth client ID → Web application**.
   > 2. Under **APIs & Services → Library**, enable the **Google Calendar API**.
   > 3. In the OAuth client, add this **Authorized redirect URI**: `<CALLBACK_URL>`
   > 4. Copy the **Client ID** and **Client Secret** and send them to me."

2. **When they paste the Client ID + Secret**, save them:
   ```bash
   curl -s -X POST "$NOVA_PLATFORM_URL/api/agent/google-config" \
     -H "Authorization: Bearer $NOVA_AGENT_TOKEN" -H "Content-Type: application/json" \
     -d "{\"clientId\":\"THE_ID\",\"clientSecret\":\"THE_SECRET\"}"
   ```

3. **Get the authorization link and send it to them:**
   ```bash
   curl -s "$NOVA_PLATFORM_URL/api/agent/google-auth-url" -H "Authorization: Bearer $NOVA_AGENT_TOKEN" \
     | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s).url||'')})"
   ```
   Tell the user:
   > "Open this link, pick your Google account, and approve. You'll see an
   > 'unverified app' screen — that's expected since it's *your own* app, so
   > click **Advanced → Go to … (unsafe)** and continue. Then tell me 'done'."
   > `<the url>`

4. **When they say done, verify:**
   ```bash
   curl -s "$NOVA_PLATFORM_URL/api/agent/google-connected" -H "Authorization: Bearer $NOVA_AGENT_TOKEN"
   ```
   If `connected:true` → "🎉 Your calendar's connected! Want me to show your next few events?" If still false → ask them to finish the authorization and try again.

## Operations (Calendar v3 REST API)
Use `primary` for the main calendar. Times are RFC3339.

**List upcoming events:**
```bash
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
curl -s "https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=15&timeMin=$NOW" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```
**Free/busy:**
```bash
curl -s -X POST "https://www.googleapis.com/calendar/v3/freeBusy" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"timeMin":"2026-06-11T09:00:00Z","timeMax":"2026-06-11T18:00:00Z","items":[{"id":"primary"}]}'
```
**Create event:**
```bash
curl -s -X POST "https://www.googleapis.com/calendar/v3/calendars/primary/events" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"summary":"Lunch with Dana","start":{"dateTime":"2026-06-11T12:30:00","timeZone":"Asia/Jerusalem"},"end":{"dateTime":"2026-06-11T13:30:00","timeZone":"Asia/Jerusalem"}}'
```
**Update/move** (PATCH, need event id): `PATCH …/events/EVENT_ID` with the changed fields.
**Delete** (need event id): `DELETE …/events/EVENT_ID` (204 = done).
Find an event id by listing events and matching summary/time. Confirm before deleting or moving.

## Notes
- Default to the user's timezone; ask if ambiguous.
- Never print tokens or the client secret.
- After an action, confirm concisely with the time + link.
