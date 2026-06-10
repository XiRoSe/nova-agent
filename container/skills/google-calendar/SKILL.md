# Skill: Google Calendar

## Description
Read and manage the user's Google Calendar — list upcoming events, check
availability (free/busy), and create, move, update, or delete events on their
behalf.

## When to Use
- User asks "what's on my calendar", "am I free…", "when's my next meeting"
- User asks to schedule / book / add an event or reminder
- User asks to move, reschedule, update, or cancel an event
- Any task that needs to read or change the user's calendar

## Auth / Setup
Calendar uses the same Google OAuth as Gmail. The credentials are provided as
env vars (available in your shell):

- `NOVA_GOOGLE_CLIENT_ID`
- `NOVA_GOOGLE_CLIENT_SECRET`
- `NOVA_GOOGLE_REFRESH_TOKEN` (must be authorized with the
  `https://www.googleapis.com/auth/calendar` scope)

**If `NOVA_GOOGLE_REFRESH_TOKEN` is empty**, Google Calendar isn't connected —
tell the user: *"Connect your Google Calendar first (Settings → Connect Google,
or ask the admin to set it up), then I can manage it for you."* Do not guess.

## Get an access token (always do this first)
Refresh tokens are long-lived; mint a short-lived access token for each session:

```bash
ACCESS_TOKEN=$(curl -s -X POST https://oauth2.googleapis.com/token \
  -d "client_id=$NOVA_GOOGLE_CLIENT_ID" \
  -d "client_secret=$NOVA_GOOGLE_CLIENT_SECRET" \
  -d "refresh_token=$NOVA_GOOGLE_REFRESH_TOKEN" \
  -d "grant_type=refresh_token" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).access_token||''))")
```
If `ACCESS_TOKEN` is empty, the connection is broken — tell the user to reconnect.

## Operations (Calendar v3 REST API)
Use `primary` for the user's main calendar. Times are RFC3339
(`2026-06-11T15:00:00-07:00` or with a `timeZone`).

**List upcoming events:**
```bash
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
curl -s "https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=15&timeMin=$NOW" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

**Check free/busy for a window:**
```bash
curl -s -X POST "https://www.googleapis.com/calendar/v3/freeBusy" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"timeMin":"2026-06-11T09:00:00Z","timeMax":"2026-06-11T18:00:00Z","items":[{"id":"primary"}]}'
```

**Create an event:**
```bash
curl -s -X POST "https://www.googleapis.com/calendar/v3/calendars/primary/events" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{
        "summary":"Lunch with Dana",
        "location":"Cafe Noir",
        "description":"Catch-up",
        "start":{"dateTime":"2026-06-11T12:30:00","timeZone":"Asia/Jerusalem"},
        "end":{"dateTime":"2026-06-11T13:30:00","timeZone":"Asia/Jerusalem"},
        "attendees":[{"email":"dana@example.com"}]
      }'
```
The response includes the event `id` and `htmlLink` — share the link with the user.

**Update / move an event** (PATCH only the fields that change; need the event id):
```bash
curl -s -X PATCH "https://www.googleapis.com/calendar/v3/calendars/primary/events/EVENT_ID" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"start":{"dateTime":"2026-06-11T14:00:00","timeZone":"Asia/Jerusalem"},
       "end":{"dateTime":"2026-06-11T15:00:00","timeZone":"Asia/Jerusalem"}}'
```

**Delete / cancel an event:**
```bash
curl -s -o /dev/null -w "%{http_code}" -X DELETE \
  "https://www.googleapis.com/calendar/v3/calendars/primary/events/EVENT_ID" \
  -H "Authorization: Bearer $ACCESS_TOKEN"   # 204 = deleted
```

**Find an event id** before updating/deleting: list events, match by summary/time,
read its `id`. Confirm with the user before deleting or moving anything.

## Notes
- Default to the user's timezone; ask if it's ambiguous.
- Never print the access token or the refresh token.
- For "schedule a meeting with X", check free/busy first, then create the event
  and report the time + link.
- Be concise: after an action, confirm what you did (e.g. "Booked Lunch with Dana,
  Thu 12:30–13:30 — here's the link").
