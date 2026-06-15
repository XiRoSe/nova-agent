# Skill: Railway Deployment

## Description
Deploy apps, services, APIs, and monitors to Railway from inside the agent container.

## When to Use
- User asks to build and deploy an app
- User needs a persistent service (monitor, scraper, scheduled task)
- User wants a public URL for something the agent built
- The agent needs to deploy something that runs independently of the container

## Setup
Install Railway CLI: `npm install -g @railway/cli`
Auth: Railway token is pre-configured via RAILWAY_TOKEN env var.

## Implementation
```bash
# Login (already done via token)
railway login --token $RAILWAY_TOKEN

# Create a new project
railway init --name "user-app-name"

# Deploy from a directory
cd /home/nova/data/apps/my-app
railway up

# Deploy with a specific service
railway up --service my-service

# Get deployment URL
railway domain

# Set environment variables
railway variables set KEY=value

# View logs
railway logs
```

## From Node.js
```typescript
import { execSync } from 'child_process';

function deployToRailway(appDir: string, projectName: string) {
  execSync(`cd "${appDir}" && railway init --name "${projectName}"`, { stdio: 'pipe' });
  const output = execSync(`cd "${appDir}" && railway up`, { stdio: 'pipe' });
  const domain = execSync(`cd "${appDir}" && railway domain`, { stdio: 'pipe' });
  return { output: output.toString(), url: domain.toString().trim() };
}
```

## Deployment Flow
1. Agent writes code in `/home/nova/data/apps/{app-name}/`
2. Agent tests it locally in the container
3. Agent deploys to Railway
4. Agent returns the live URL to the user
5. Agent stores the project reference for future updates

## What Can Be Deployed
- React/Next.js frontends (dashboards, portals, landing pages)
- Node.js/Express APIs
- Python scripts and services
- Cron jobs and scheduled monitors
- Databases (Postgres, Redis via Railway add-ons)

## Notes
- Each deployment creates a Railway project linked to the user
- Store project references in /home/nova/data/config/railway-projects.json
- User's Railway token is scoped — the agent can only access their projects
- Always test locally before deploying
