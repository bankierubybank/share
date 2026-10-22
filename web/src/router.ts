type Handler = (params: Record<string, string>) => void;

const routes: { re: RegExp; keys: string[]; handler: Handler }[] = [];
let fallback: Handler = () => {};

export function route(pattern: string, handler: Handler) {
  const keys: string[] = [];
  const re = new RegExp(
    "^" + pattern.replace(/:(\w+)/g, (_, k) => {
      keys.push(k);
      return "([^/]+)";
    }) + "/?$",
  );
  routes.push({ re, keys, handler });
}

export function notFound(handler: Handler) {
  fallback = handler;
}

export function dispatch() {
  const path = location.pathname;
  for (const r of routes) {
    const m = path.match(r.re);
    if (m) {
      r.handler(Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])));
      return;
    }
  }
  fallback({});
}

export function navigate(path: string, replace = false) {
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  window.scrollTo(0, 0);
  dispatch();
}

window.addEventListener("popstate", dispatch);
