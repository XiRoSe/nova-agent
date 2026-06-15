# Skill: Capabilities Reference

## Description
Complete list of Nova's available capabilities. Check here when unsure if something is possible before telling the user it can't be done.

## Core
- Web search: `WebSearch` tool
- Web browsing: `agent-browser open <url>` then `agent-browser snapshot -i` to interact
- File read/write/edit in workspace
- Bash commands (install packages, run scripts, build software)
- Schedule tasks: `mcp__nanoclaw__schedule_task`
- Send messages: `mcp__nanoclaw__send_message`

## Data Access
- WhatsApp message history: query `/data/store/messages.db` SQLite (see whatsapp-history skill)
  - Tables: `messages` (chat_jid, sender, sender_name, content, timestamp), `chats` (jid, name), `registered_groups`
- Persistent workspace: `/workspace/group/` and `/data/groups/<group>/`

## AI & Multimodal (via Replicate)
- Image generation: `replicate run black-forest-labs/flux-1.1-pro --input prompt="..."`
- Image analysis, audio transcription, video generation, upscaling, OCR
- See replicate skill for full usage

## Integrations (if connected)
- Google Calendar: create/read/update/delete events (google-calendar skill)
- Gmail: read/search/send/reply (gmail skill)
- GitHub: clone, read, commit, push, PR/issue management (github skill)
- Railway: deploy apps, set env vars, create services (railway-deploy skill)

## Self-Modification
- Clone own repo: `git clone https://$NOVA_GITHUB_TOKEN@github.com/XiRoSe/nova-agent.git`
- Push changes to persist across redeployments
- Redeploy self via Railway API

## When to Check Here
Before saying "I can't do X" — verify against this list first. Most things are possible.
