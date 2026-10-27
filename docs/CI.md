# CI / CD (draft — #18)

Status: **drafted, not active.** The workflows in `.github/workflows/` start running once the repo is pushed to GitHub
and the secrets below exist. Until then, `npm run ship` stays the way to release.

## What runs

| Workflow | Trigger | Does | Secrets |
|----------|---------|------|---------|
| `ci.yml` | every push to `main`, every PR | `npm run test:local`: typecheck → unit → build → integration → `wrangler dev` → system / security / E2E (chromium, webkit, mobile-chrome, mobile-safari) | none (local Worker + local D1) |
| `deploy.yml` | `ci` succeeded on `main` (or "Run workflow" by hand) | prod D1 export → R2 `share-backups/predeploy/` · `npm run deploy` (build + remote migrations + `wrangler deploy`) · `npm run test:prod` · on failure `wrangler rollback` | `CLOUDFLARE_API_TOKEN`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` |

Same rules as `CLAUDE.md` → Workflow: never deploy if local fails; prod tests failing → roll back (the Worker only —
migrations stay, so they must be backwards-compatible). Deploys never run in parallel (`concurrency: deploy-prod`).

## One-time setup (owner)

1. Create the repo (suggested names below) — **private** (prod test output and logs mention trip names).
2. `git remote add origin git@github.com:<you>/<repo>.git && git push -u origin main`
3. Settings → Secrets and variables → Actions → *New repository secret*:
   - `CLOUDFLARE_API_TOKEN` — a **new** token just for CI (don't reuse `.env`'s): Account → Workers Scripts:Edit,
     D1:Edit, Workers R2 Storage:Edit; limited to account `d20bca6d…`.
   - `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` — the `share-tests` service token (rotate it first: ISSUES #9).
4. Settings → Environments → `production` → optionally *Required reviewers* (you) to approve each deploy.
5. Settings → Branches → protect `main`: require the `ci / local-gate` check.

## Repo name ideas

| Name | Why |
|------|-----|
| `share` | Matches the Worker, D1 (`share-db`) and R2 names — zero renaming. |
| `share-bills` | Same, but says what it is when it sits among other repos. |
| `tripsplit` | Says the use case (trips) — fine as a repo name even if the Worker stays `share`. |
| `haan` (หาร, "divide") | Short Thai word for splitting a bill (`หารกัน`); nice if the app ever gets a brand. |
| `kitty` | The shared trip pot; nods to KittySplit. |

Recommendation: **`share`** (or `share-bills` if the short name is taken) — every Cloudflare resource is already
named `share*`, so docs, scripts and the workflows need no edits.
