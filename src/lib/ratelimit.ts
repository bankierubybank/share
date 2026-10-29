// Which rate limits apply to a request, and under which key (docs/ARCHITECTURE.md → Security model).

/** Routes keyed by a link token someone could try to guess. */
export const LINK_ROUTE_RE = /^\/api\/(join|view)\//;

export interface RatePlan {
  /** Counter key; null = no limits at all (service tokens / local tests without the opt-in header). */
  key: string | null;
  /** Also apply the stricter link limit. */
  link: boolean;
}

/**
 * - People: keyed by their verified identity (IP when there is none); API limit always, link limit on link routes.
 * - Service tokens (`svc:…`, our test automation; users can't get one): no limits unless a test opts in with
 *   `X-Test-Rate-Key` — the prod suites send 600+ requests a minute and probe dozens of view/join ids on purpose
 *   (ISSUES #37, #40). Opted in, they're counted under their own identity like a person.
 * - Local dev / tests (DEV_IDENTITY): nothing unless a test opts in; then keyed by that header (its own counter),
 *   so parallel E2E workers sharing one dev identity aren't throttled.
 */
export function ratePlan(identity: string | null, ip: string | null, path: string, optInKey: string | null, dev: boolean): RatePlan {
  const linkRoute = LINK_ROUTE_RE.test(path);
  if (dev) return optInKey ? { key: `test:${optInKey}`, link: linkRoute } : { key: null, link: false };
  if (identity?.startsWith("svc:") && !optInKey) return { key: null, link: false };
  return { key: identity ?? `ip:${ip ?? "unknown"}`, link: linkRoute };
}
