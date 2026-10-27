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
   - Local dev / tests don't use Access: `wrangler dev --var DEV_IDENTITY:1` trusts the
     `Cf-Access-Authenticated-User-Email` header (default `dev@example.com`). Never set DEV_IDENTITY on prod.
4. Verify: `npm run test:prod`. With a token present, the security suite also asserts that requests
   **without** the token are blocked (302/401/403).

Note: `*.workers.dev` hostnames can be protected by Access from Workers → share → Settings → Domains &
Routes → workers.dev → "Enable Cloudflare Access" (creates the Access app for you).
