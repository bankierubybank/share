// Tiny DOM builder. User data only ever goes through text nodes / properties — never innerHTML.

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & { class?: string; style?: string; dataset?: Record<string, string> };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K];
export function h(tag: string, props?: Props | null, ...children: Child[]): HTMLElement;
export function h(tag: string, props?: Props | null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "style") el.setAttribute("style", String(v));
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k.startsWith("attr:")) el.setAttribute(k.slice(5), v === true ? "" : String(v));
    else if (k in el) (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
}

export const icon = (name: string, slot?: string) => h("md-icon", slot ? { slot } : null, name);

export function clear(el: Element, ...children: Child[]) {
  el.replaceChildren();
  append(el, children);
}

let snackTimer: number | undefined;
export function snackbar(message: string, action?: { label: string; run: () => void }) {
  let bar = document.getElementById("snackbar");
  if (!bar) {
    bar = h("div", { id: "snackbar", class: "snackbar", role: "status", "aria-live": "polite" });
    document.body.appendChild(bar);
  }
  clear(
    bar,
    h("span", { class: "snackbar-text" }, message),
    action &&
      h("md-text-button", { class: "snackbar-action", onclick: () => { hide(); action.run(); } }, action.label),
  );
  bar.classList.add("show");
  const hide = () => bar!.classList.remove("show");
  clearTimeout(snackTimer);
  snackTimer = window.setTimeout(hide, 4000);
}
