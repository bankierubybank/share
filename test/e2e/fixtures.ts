import { test as base, expect } from "@playwright/test";

// Cloudflare Access service token is attached ONLY to requests for the app's own origin.
// Never use `extraHTTPHeaders` for it: that sends the secret to every host (e.g. Google Fonts).
// Groups created during a test are deleted afterwards so prod runs don't accumulate data.
export const test = base.extend({
  context: async ({ context, baseURL }, use) => {
    const id = process.env.CF_ACCESS_CLIENT_ID;
    const secret = process.env.CF_ACCESS_CLIENT_SECRET;
    const accessHeaders: Record<string, string> = id && secret ? { "cf-access-client-id": id, "cf-access-client-secret": secret } : {};
    const origin = baseURL ? new URL(baseURL).origin : "";
    if (id && secret && baseURL) {
      await context.route(
        // http(s) only: blob: URLs share the page origin, and routing them breaks downloads.
        (url) => url.protocol.startsWith("http") && url.origin === origin,
        (route) => route.continue({ headers: { ...route.request().headers(), ...accessHeaders } }),
      );
    }
    const created: string[] = [];
    context.on("response", async (res) => {
      const req = res.request();
      if (req.method() === "POST" && res.status() === 201 && new URL(res.url()).pathname === "/api/groups") {
        const gid = (await res.json().catch(() => null))?.group?.id;
        if (typeof gid === "string") created.push(gid);
      }
    });
    await use(context);
    for (const gid of created) {
      // 404 = the test already deleted it.
      await context.request.delete(`${origin}/api/groups/${gid}`, { headers: accessHeaders }).catch(() => undefined);
    }
  },
});

export { expect };
