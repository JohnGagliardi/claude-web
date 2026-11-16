import { socket } from "./api";

// "Area" comes from the nearest ancestor that already carries one of these
// landmark classNames — no need to sprinkle data-area attributes everywhere;
// the existing layout classes already say where a click happened.
const LANDMARKS = [
  "composer",
  "dock",
  "sidebar",
  "app-topbar",
  "topbar",
  "side-pane",
  "info-col",
  "settings",
  "schedules",
  "modal",
  "slash-menu",
  "ctx-menu",
  "transcript",
].map((c) => `.${c}`).join(", ");

function labelOf(el: HTMLElement): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return aria;
  const title = el.getAttribute("title");
  if (title) return title;
  const text = el.textContent?.trim().replace(/\s+/g, " ");
  if (text) return text.slice(0, 40);
  const cls = el.className.split(/\s+/).filter(Boolean)[0];
  return cls || el.tagName.toLowerCase();
}

function areaOf(el: HTMLElement): string | undefined {
  return el.closest<HTMLElement>(LANDMARKS)?.classList[0];
}

// Delegated click tracking: every button/link in the app funnels through one
// listener here instead of each component wiring its own analytics call.
// Fire-and-forget over the existing socket; see server/usage.ts for storage.
export function installClickTracking() {
  document.addEventListener(
    "click",
    (e) => {
      const target = e.target as HTMLElement | null;
      const el = target?.closest<HTMLElement>("button, a[href], [role='button']");
      if (!el) return;
      socket.send({ t: "track", action: labelOf(el), area: areaOf(el), ts: Date.now() });
    },
    { capture: true },
  );
}
