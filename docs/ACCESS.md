# Cloudflare Access setup (manual, by owner)

1. **Zero Trust → Access → Applications → Add → Self-hosted**
   - Domain: `share.bankierubybank.workers.dev` (path empty = whole site).
   - Policy "People": Action *Allow*, Include e.g. *Emails* / *Emails ending in*.
2. **Service token for automated tests**
   - Zero Trust → Access → Service Auth → Service Tokens → *Create* (name `share-tests`).
   - Copy Client ID + Secret into `.env.test` (template: `.env.test.example`; git-ignored).
   - On the app add policy "Tests": Action **Service Auth**, Include **Service Token = share-tests**.
3. **In-Worker JWT verification — required since v0.4** (the verified identity decides which trips you see).
   - Set in `wrangler.jsonc` → `vars`: `ACCESS_TEAM_DOMAIN` (`bankierubybank.cloudflareaccess.com`) and `ACCESS_AUD`
     (the app's AUD tag, app → Overview). Both are set. If the Access app is ever re-created, the AUD changes:
     update it, or every request gets 401.
   - Worker 401s any request lacking a valid `Cf-Access-Jwt-Assertion`. Identity = JWT `email`, or
     `svc:<client id>` for service tokens (tests). A trip opens only for identities linked to one of its people.
   - Local dev / tests don't use Access: `wrangler dev --local --var DEV_IDENTITY:1` trusts the
     `Cf-Access-Authenticated-User-Email` header (default `dev@example.com`). Never set DEV_IDENTITY on prod.
4. Verify: `npm run test:prod`. With a token present, the security suite also asserts that requests
   **without** the token are blocked (302/401/403).

Note: `*.workers.dev` hostnames can be protected by Access from Workers → share → Settings → Domains &
Routes → workers.dev → "Enable Cloudflare Access" (creates the Access app for you).

## Invite links (v0.6) and the Access policy
An invite link lets someone join a trip without anyone typing their email under People — but it does **not**
get them past Access: they must match the app's "People" policy. Owner's choice:
- Keep the policy narrow (*Emails* list) and add each new person there too. Safest; two steps per person.
- Widen it (e.g. *Emails ending in* `@gmail.com`, or *Everyone* with the One-time PIN login method). Since v0.4 a
  signed-in stranger still sees no trips: trips open only for linked people, and joining needs a live invite link.
  They can still use the app for themselves (create their own trips — D1 storage on your account), capped by the
  per-identity rate limits. Prefer a domain or email list over *Everyone*.
