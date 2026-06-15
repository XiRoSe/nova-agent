---
name: self-management
description: Configure and modify yourself (Nova). Use when asked to set or change your own environment variables, redeploy yourself, connect or reconnect a messaging channel (WhatsApp/Telegram/Discord/Slack/Gmail), check your own deploy logs for pairing or auth codes, write a new skill, install packages, edit your own source code, or create/deploy a new app, service, or database on Railway.
---

# Self-Management

You run on Railway and can configure, redeploy, and modify yourself, and deploy new
services. All actions use the `NOVA_*` env vars already present in your environment:

- `NOVA_RAILWAY_TOKEN` — Railway API bearer token
- `NOVA_RAILWAY_SERVICE_ID` — your own service ID
- `NOVA_RAILWAY_PROJECT_ID` — project ID
- `NOVA_RAILWAY_ENVIRONMENT_ID` — environment ID
- `NOVA_GITHUB_TOKEN` — GitHub token for your source repo
- `NOVA_GITHUB_REPO` — your source repo (e.g. `XiRoSe/nova-agent`)

Never print or echo these tokens.

## Self-Configuration

### Set an environment variable on yourself
```bash
curl -s -X POST https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer $NOVA_RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation { variableCollectionUpsert(input: { projectId: \"'$NOVA_RAILWAY_PROJECT_ID'\", environmentId: \"'$NOVA_RAILWAY_ENVIRONMENT_ID'\", serviceId: \"'$NOVA_RAILWAY_SERVICE_ID'\", variables: { KEY: \"value\" } }) }"}'
```

### Redeploy yourself (needed after env var changes)
```bash
curl -s -X POST https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer $NOVA_RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation { serviceInstanceDeploy(serviceId: \"'$NOVA_RAILWAY_SERVICE_ID'\", environmentId: \"'$NOVA_RAILWAY_ENVIRONMENT_ID'\") }"}'
```

### Channel connection env vars
| Channel | Env Vars Needed |
|---------|----------------|
| WhatsApp | `WHATSAPP_PHONE` |
| Telegram | `TELEGRAM_BOT_TOKEN` |
| Discord | `DISCORD_BOT_TOKEN` |
| Slack | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` |
| Gmail | `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` |

Walk the user through getting credentials step by step.

### When to redeploy vs not
- **First time setting a channel env var** → set the var, then redeploy.
- **WhatsApp pairing code expired/failed** → DON'T redeploy. Call `curl -s -X POST http://localhost:8080/api/retry-whatsapp` to restart pairing without a full redeploy.
- **Changing a channel token** → set the new var, then redeploy.
- **General rule**: only redeploy when env vars CHANGE. If they're already set, use internal restart endpoints.

### After redeploying yourself
When the user reconnects after a redeploy, ALWAYS check your own deploy logs for setup codes/credentials:
```bash
DEPLOY_ID=$(curl -s -X POST https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer $NOVA_RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"query { deployments(input: { projectId: \"'$NOVA_RAILWAY_PROJECT_ID'\", serviceId: \"'$NOVA_RAILWAY_SERVICE_ID'\" }, first: 1) { edges { node { id } } } }"}' | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4) && \
curl -s -X POST https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer $NOVA_RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"query { deploymentLogs(deploymentId: \"'$DEPLOY_ID'\", limit: 50) { message } }"}' 2>&1
```
Look for: WhatsApp pairing/QR code, Telegram/Discord/Slack connected confirmation, Gmail auth URL. Present the relevant info clearly — the user should never need to open the Railway dashboard.

### WhatsApp specific flow
After setting `WHATSAPP_PHONE` and redeploying:
- The WhatsApp adapter starts with the phone number.
- A **pairing code** appears in the deploy logs (format `XXXX-XXXX`).
- Show it: "Open WhatsApp → Settings → Linked Devices → Link a Device → enter code: XXXX-XXXX".
- If no code appears, check logs for errors and report to the user.

## Self-Evolution

### Write a new skill
Skills live in `container/skills/<name>/SKILL.md` and MUST start with YAML
frontmatter (`name` + `description`). Claude indexes the description and loads the
body **only when the description matches the task** — so write a description that
spells out the trigger phrases/tasks, or the skill won't fire. Keep the body for
the detailed how-to.
```bash
mkdir -p container/skills/my-new-skill
cat > container/skills/my-new-skill/SKILL.md << 'EOF'
---
name: my-new-skill
description: What it does and exactly when to use it — list the trigger phrases and tasks so it gets matched.
---

# My New Skill

Full instructions / implementation here. This body loads only when the skill triggers.
EOF
```
To make a new skill **durable** across redeploys, commit it to your repo (see "Modify your own code") and redeploy — a skill written only to the running container is lost on the next deploy.

### Install packages
`npm install -g <pkg>` / `pip install <pkg>`. Note: container installs are lost on
redeploy. For anything durable, add it to the repo (Dockerfile / package.json) and
redeploy.

### Modify your own code (persistent)
Your source is `$NOVA_GITHUB_REPO`. Clone, edit, commit, push, then redeploy:
```bash
git clone https://$NOVA_GITHUB_TOKEN@github.com/$NOVA_GITHUB_REPO.git /tmp/self-update
cd /tmp/self-update
# ...edit files...
git config user.email "nova-agent@nova.com"
git config user.name "Nova Agent"
git add -A && git commit -m "Self-update: <description>"
git push
```
Then redeploy yourself (see "Redeploy yourself" above).

### Deploy new Railway services for the user
Create services, connect repos, set env vars, generate domains, add databases:
```bash
# Create a new service
curl -s -X POST https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer $NOVA_RAILWAY_TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"mutation { serviceCreate(input: { projectId: \"'$NOVA_RAILWAY_PROJECT_ID'\", name: \"my-app\" }) { id name } }"}'

# Connect a GitHub repo to the service
curl -s -X POST https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer $NOVA_RAILWAY_TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"mutation { serviceConnect(id: \"SERVICE_ID\", input: { repo: \"owner/repo\", branch: \"main\" }) { id } }"}'

# Set env vars on the new service
curl -s -X POST https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer $NOVA_RAILWAY_TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"mutation { variableCollectionUpsert(input: { projectId: \"'$NOVA_RAILWAY_PROJECT_ID'\", environmentId: \"'$NOVA_RAILWAY_ENVIRONMENT_ID'\", serviceId: \"SERVICE_ID\", variables: { KEY: \"value\" } }) }"}'

# Generate a public domain
curl -s -X POST https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer $NOVA_RAILWAY_TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"mutation { serviceDomainCreate(input: { serviceId: \"SERVICE_ID\", environmentId: \"'$NOVA_RAILWAY_ENVIRONMENT_ID'\" }) { domain } }"}'

# Add a database
curl -s -X POST https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer $NOVA_RAILWAY_TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"mutation { serviceCreate(input: { projectId: \"'$NOVA_RAILWAY_PROJECT_ID'\", name: \"postgres\", source: { image: \"postgres:16\" } }) { id } }"}'
```
You can build full applications: write the code, create a repo, push it, deploy on Railway, and hand the user a live URL.
