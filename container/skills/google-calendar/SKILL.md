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

## Get an access token (always do this first)
Each user connects their **own** Google account in the Nova dashboard
(Settings → Connect Google). The token lives in the platform DB; you fetch a
ready, auto-refreshed access token on demand — never handle the user's refresh
token yourself:

```bash
RESP=$(curl -s "$NOVA_PLATFORM_URL/api/agent/google-token" \
  -H "Authorization: Bearer $NOVA_AGENT_TOKEN")
ACCESS_TOKEN=$(echo "$RESP" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).token||'')}catch{console.log('')}})")
```

**If `ACCESS_TOKEN` is empty** (the response has `connected:false`), this user
hasn't connected Google Calendar — tell them: *"Connect your Google Calendar in
the Nova dashboard → Settings, then I can manage it for you."* Do not guess.

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
