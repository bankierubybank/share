import { test as base, expect } from "@playwright/test";

// Cloudflare Access service token is attached ONLY to requests for the app's own origin.
// Never use `extraHTTPHeaders` for it: that sends the secret to every host (e.g. Google Fonts).
export const test = base.extend({
  context: async ({ context, baseURL }, use) => {
    const id = process.env.CF_ACCESS_CLIENT_ID;
    const secret = process.env.CF_ACCESS_CLIENT_SECRET;
    if (id && secret && baseURL) {
      const origin = new URL(baseURL).origin;
      await context.route(
        (url) => url.origin === origin,
        (route) =>
          route.continue({
            headers: { ...route.request().headers(), "cf-access-client-id": id, "cf-access-client-secret": secret },
          }),
      );
    }
    await use(context);
  },
});

export { expect };
