# Skill: GitHub

## Description
Read and write the user's GitHub — clone/read/edit/push repos, and use the API
for repos, branches, issues, pull requests, and more. Per-user connection, the
token is fetched on demand. Connecting is **in chat** (any channel).

## When to Use
- "connect my github" → run the **Connecting** flow below
- "what are my repos", "open an issue", "create a PR", "read/edit code in <repo>"
- Any task that reads or writes the user's GitHub repos

## Always check connection first
```bash
RESP=$(curl -s "$NOVA_PLATFORM_URL/api/agent/github-token" -H "Authorization: Bearer $NOVA_AGENT_TOKEN")
GH_TOKEN=$(echo "$RESP" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).token||'')}catch{console.log('')}})")
GH_LOGIN=$(echo "$RESP" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).login||'')}catch{console.log('')}})")
```
If `GH_TOKEN` is non-empty → connected. If empty → run **Connecting**.

## Connecting (first time) — conversational, one step
GitHub OAuth needs **no app setup and no verification** — just one click. So this
is simpler than Google: no "create an app" step.

1. **Get the link** and hand it to the user verbatim:
   ```bash
   curl -s "$NOVA_PLATFORM_URL/api/agent/github-auth-url" -H "Authorization: Bearer $NOVA_AGENT_TOKEN" \
     | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s).url||'')})"
   ```
   Tell the user:
   > "Click here to connect your GitHub — approve the access, then tell me 'done':
   > `<paste the url verbatim>`"

2. **When they say done, verify:**
   ```bash
   curl -s "$NOVA_PLATFORM_URL/api/agent/github-connected" -H "Authorization: Bearer $NOVA_AGENT_TOKEN"
   ```
   `connected:true` → "🎉 GitHub connected — I can read and write your repos now."
   Otherwise → ask them to finish approving, then check again.

## Using it

**Git (clone / push):** once connected, git auth is wired up — plain HTTPS works.
If you ever need it explicit, embed the token:
```bash
git clone "https://$GH_TOKEN@github.com/$GH_LOGIN/REPO.git"
cd REPO && git config user.name "$GH_LOGIN" && git config user.email "$GH_LOGIN@users.noreply.github.com"
# edit, then: git add -A && git commit -m "..." && git push
```

**API (repos / issues / PRs)** — base `https://api.github.com`, header
`Authorization: Bearer $GH_TOKEN`:
```bash
# list the user's repos (most recent)
curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/user/repos?sort=updated&per_page=10"

# open an issue
curl -s -X POST -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$GH_LOGIN/REPO/issues" \
  -d '{"title":"Bug: ...","body":"Details..."}'

# create a pull request (head -> base)
curl -s -X POST -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$GH_LOGIN/REPO/pulls" \
  -d '{"title":"...","head":"feature-branch","base":"main","body":"..."}'
```
The connection has the `repo` scope (full read/write on the user's repos).

## Notes
- Never print `$GH_TOKEN`.
- Confirm before pushing, opening PRs/issues, or deleting anything.
- For multi-file work, clone the repo, edit locally, commit, and push.
