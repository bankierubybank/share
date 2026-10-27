// Touch gestures for phones: swipe-left on a row, long-press, pull-to-refresh.
// Every gesture has a non-gesture equivalent in the UI (buttons in the bill dialog / a refresh on load), so
// keyboard and screen-reader users lose nothing.

const SWIPE_TRIGGER = 96; // px
const LONG_PRESS_MS = 550;

export interface RowGestures {
  onSwipeLeft?: () => void;
  onLongPress?: () => void;
}

/** Attaches swipe-left (touch/pen only) and long-press to a row. Returns a detach function. */
export function attachRowGestures(el: HTMLElement, g: RowGestures): () => void {
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let tracking = false;
  let swiping = false;
  let timer: number | undefined;
  let longPressed = false;

  const reset = () => {
    clearTimeout(timer);
    tracking = swiping = false;
    el.style.transition = "transform 150ms ease-out";
    el.style.transform = "";
    el.classList.remove("swiping", "swipe-armed");
  };

  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
    longPressed = false;
    tracking = e.pointerType !== "mouse" && !!g.onSwipeLeft;
    if (g.onLongPress)
      timer = window.setTimeout(() => {
        longPressed = true;
        tracking = false;
        navigator.vibrate?.(15);
        g.onLongPress!();
      }, LONG_PRESS_MS);
  };
  const move = (e: PointerEvent) => {
    const mx = e.clientX - startX;
    const my = e.clientY - startY;
    if (Math.abs(mx) > 8 || Math.abs(my) > 8) clearTimeout(timer);
    if (!tracking) return;
    if (!swiping) {
      if (Math.abs(my) > Math.abs(mx) || Math.abs(mx) < 12) return; // vertical scroll wins
      swiping = true;
      el.classList.add("swiping");
      el.setPointerCapture?.(e.pointerId);
    }
    dx = Math.min(0, mx);
    el.style.transition = "none";
    el.style.transform = `translateX(${dx}px)`;
    el.classList.toggle("swipe-armed", -dx > SWIPE_TRIGGER);
  };
  const up = () => {
    const fire = swiping && -dx > SWIPE_TRIGGER;
    reset();
    if (fire) g.onSwipeLeft!();
  };
  // A long-press or a swipe must not also count as a tap.
  const click = (e: MouseEvent) => {
    if (longPressed || Math.abs(dx) > 8) {
      e.preventDefault();
      e.stopImmediatePropagation();
      longPressed = false;
      dx = 0;
    }
  };
  const ctx = (e: Event) => g.onLongPress && e.preventDefault(); // no native menu on long-press

  el.addEventListener("pointerdown", down);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", reset);
  el.addEventListener("click", click, true);
  el.addEventListener("contextmenu", ctx);
  return () => {
    el.removeEventListener("pointerdown", down);
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", reset);
    el.removeEventListener("click", click, true);
    el.removeEventListener("contextmenu", ctx);
  };
}

/** Pull down from the top of the page to refresh (touch only). One instance per page. */
let detachPull: (() => void) | null = null;
export function detachPullToRefresh() {
  detachPull?.();
  detachPull = null;
}
export function attachPullToRefresh(indicator: HTMLElement, onRefresh: () => Promise<unknown>) {
  detachPull?.();
  let startY = 0;
  let pulling = false;
  let dy = 0;
  const start = (e: TouchEvent) => {
    pulling = window.scrollY <= 0 && e.touches.length === 1 && !document.querySelector("md-dialog[open]");
    startY = e.touches[0].clientY;
    dy = 0;
  };
  const move = (e: TouchEvent) => {
    if (!pulling) return;
    dy = Math.max(0, e.touches[0].clientY - startY);
    indicator.style.transform = `translateY(${Math.min(dy, 120) * 0.5}px)`;
    indicator.classList.toggle("armed", dy > 90);
    indicator.classList.toggle("visible", dy > 10);
  };
  const end = async () => {
    if (!pulling) return;
    pulling = false;
    const go = dy > 90;
    indicator.style.transform = "";
    indicator.classList.remove("armed");
    if (go) {
      indicator.classList.add("visible", "spinning");
      try {
        await onRefresh();
      } finally {
        indicator.classList.remove("visible", "spinning");
      }
    } else indicator.classList.remove("visible");
  };
  window.addEventListener("touchstart", start, { passive: true });
  window.addEventListener("touchmove", move, { passive: true });
  window.addEventListener("touchend", end);
  detachPull = () => {
    window.removeEventListener("touchstart", start);
    window.removeEventListener("touchmove", move);
    window.removeEventListener("touchend", end);
  };
}
