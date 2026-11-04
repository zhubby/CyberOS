import { useEffect, useRef } from "react";
import { closeModalForHome } from "../components/workspace/useModalDialog.js";
import { isBackKey, isHomeKey } from "../lib/remote-keys.js";

type Direction = "left" | "right" | "up" | "down";
export function useRemoteNavigation(actions: {
  onBack: () => void;
  onHome: () => void;
  onSearch: () => void;
  onTransport: (key: string) => void;
}) {
  const current = useRef(actions);
  useEffect(() => { current.current = actions; }, [actions]);
  useEffect(() => {
    const memory = new WeakMap<HTMLElement, HTMLElement>();
    const handle = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const back = isBackKey(event);
      const modal = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')].at(-1);
      if (event.key === "Escape" && document.querySelector('.hud-tooltip:not([hidden])')) return;
      if (isHomeKey(event)) {
        event.preventDefault(); event.stopPropagation();
        const dialogs = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"][role="dialog"], [aria-modal="true"][role="alertdialog"]')].reverse();
        for (const dialog of dialogs) if (!closeModalForHome(dialog)) return;
        current.current.onHome();
        return;
      }
      const select = target?.closest(".custom-select");
      if (select && ((select.classList.contains("is-open") && back) || ["ArrowUp", "ArrowDown", "End", "Enter", " "].includes(event.key))) return;
      if (target?.closest(".workspace-search-filter-menu") && back) return;
      if (target?.closest(".playback-output-menu") && back) return;
      if (target?.matches("[data-tv-text-input]") && (["ArrowLeft", "ArrowRight"].includes(event.key) || (target.dataset.tvComposing === "true" && ["ArrowUp", "ArrowDown", "Enter"].includes(event.key)))) return;
      if (back) {
        // Modal owners close themselves in the bubble phase and honor busy state.
        if (modal) return;
        event.preventDefault(); current.current.onBack(); return;
      }
      if (["MediaPlayPause", "MediaPlay", "MediaPause", "MediaStop"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        if (!event.repeat && !modal) current.current.onTransport(event.key);
        return;
      }
      if (event.key === "F8") {
        event.preventDefault(); event.stopPropagation();
        if (!modal) current.current.onSearch();
        return;
      }
      if (event.key === "Enter") {
        if (target instanceof HTMLInputElement && target.type === "checkbox") { event.preventDefault(); target.click(); }
        else if (document.activeElement instanceof HTMLButtonElement) { event.preventDefault(); document.activeElement.click(); }
        return;
      }
      const direction = directionForKey(event.key);
      if (!direction) return;
      if (target instanceof HTMLInputElement && target.type === "range" && ["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      if (target instanceof HTMLSelectElement) return;
      event.preventDefault();
      moveFocus(direction, modal ?? document.querySelector<HTMLElement>(".playback-output-menu") ?? document, memory);
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, []);
}

function directionForKey(key: string): Direction | null {
  return ({ ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" } as const)[key as "ArrowLeft"] ?? null;
}

function moveFocus(direction: Direction, scope: ParentNode, memory: WeakMap<HTMLElement, HTMLElement>) {
  const candidates = [...scope.querySelectorAll<HTMLElement>('[data-tv-focusable]:not(:disabled), button:not(:disabled), input:not(:disabled), select:not(:disabled), summary')]
    .filter(element => element.getClientRects().length > 0 && !element.closest('[hidden], [inert], [aria-hidden="true"]'));
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (!active || !candidates.includes(active)) { candidates[0]?.focus(); return; }
  const region = active.closest<HTMLElement>("[data-tv-region]");
  if (region) memory.set(region, active);
  const origin = active.getBoundingClientRect();
  const scored = candidates.filter(candidate => candidate !== active).map(candidate => {
    const rect = candidate.getBoundingClientRect();
    const dx = rect.x + rect.width / 2 - origin.x - origin.width / 2;
    const dy = rect.y + rect.height / 2 - origin.y - origin.height / 2;
    const primary = direction === "left" ? -dx : direction === "right" ? dx : direction === "up" ? -dy : dy;
    const secondary = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
    return { candidate, region: candidate.closest<HTMLElement>("[data-tv-region]"), primary, score: primary + secondary * 1.8 };
  }).filter(item => item.primary > 4).sort((a, b) => a.score - b.score);
  // Horizontal rows hand Up/Down to their neighboring section, not another item in the row.
  const horizontal = region && ["navigation", "rail", "keyboard-row", "candidates", "search-header"].includes(region.dataset.tvRegion ?? "");
  const within = region && !(horizontal && (direction === "up" || direction === "down")) ? scored.find(item => item.region === region) : undefined;
  const best = within ?? scored.find(item => item.region !== region) ?? scored[0];
  if (!best) return;
  const remembered = best.region !== region && best.region ? memory.get(best.region) : null;
  const next = remembered && scored.some(item => item.candidate === remembered) ? remembered : best.candidate;
  next.focus({ preventScroll: true });
  if (best.region) memory.set(best.region, next);
  next.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest", inline: "nearest" });
}
