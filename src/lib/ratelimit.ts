// Which rate limits apply to a request, and under which key (docs/ARCHITECTURE.md → Security model).

/** Routes keyed by a link token someone could try to guess. */
export const LINK_ROUTE_RE = /^\/api\/(join|view)\//;

export interface RatePlan {
  /** Counter key; null = no limits at all (local dev / tests without the opt-in header). */
  key: string | null;
  /** Also apply the stricter link limit. */
  link: boolean;
}

/**
 * - People: keyed by their verified identity (IP when there is none); API limit always, link limit on link routes.
 * - Service tokens (`svc:…`, our test automation; users can't get one): link limit only when a test opts in with
 *   `X-Test-Rate-Key` — prod suites legitimately probe many view/join ids. The API limit still applies.
 * - Local dev / tests (DEV_IDENTITY): nothing unless a test opts in; then keyed by that header (its own counter),
 *   so parallel E2E workers sharing one dev identity aren't throttled.
 */
export function ratePlan(identity: string | null, ip: string | null, path: string, optInKey: string | null, dev: boolean): RatePlan {
  const linkRoute = LINK_ROUTE_RE.test(path);
  if (dev) return optInKey ? { key: `test:${optInKey}`, link: linkRoute } : { key: null, link: false };
  const service = identity?.startsWith("svc:") ?? false;
  return { key: identity ?? `ip:${ip ?? "unknown"}`, link: linkRoute && (!service || !!optInKey) };
}
