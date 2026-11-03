import { positionTooltip, tooltipDescription } from "./tooltip.js";

let sequence = 0;

export function mountTooltipLayer() {
  const tooltip = document.createElement("div");
  tooltip.id = `cyberos-tooltip-${++sequence}`;
  tooltip.className = "hud-tooltip";
  tooltip.setAttribute("role", "tooltip");
  let active: { trigger: Element; text: string } | null = null;
  let hovered: Element | null = null;
  let focused: Element | null = null;
  let pointerFocus = false;
  let openTimer: number | undefined;
  let closeTimer: number | undefined;
  const observer = new MutationObserver(update);
  const ancestorObserver = new MutationObserver(update);
  const resizeObserver = new ResizeObserver(update);

  function clearTimers() {
    window.clearTimeout(openTimer);
    window.clearTimeout(closeTimer);
    openTimer = undefined;
    closeTimer = undefined;
  }

  function dismiss() {
    clearTimers();
    observer.disconnect();
    ancestorObserver.disconnect();
    resizeObserver.disconnect();
    if (active) {
      const { trigger } = active;
      const remaining = tooltipDescription(trigger.getAttribute("aria-describedby"), tooltip.id, false);
      if (remaining) trigger.setAttribute("aria-describedby", remaining);
      else trigger.removeAttribute("aria-describedby");
    }
    active = null;
    tooltip.remove();
  }

  function triggerFor(target: EventTarget | null): Element | null {
    if (!(target instanceof Element)) return null;
    const trigger = target.closest("[data-tooltip]");
    return trigger?.getAttribute("data-tooltip")?.trim() && !trigger.closest('[inert], [hidden], [aria-hidden="true"]') ? trigger : null;
  }

  function update() {
    if (!active) return;
    const { trigger } = active;
    const text = trigger.getAttribute("data-tooltip")?.trim();
    if (!trigger.isConnected || !trigger.getClientRects().length || !text || trigger.closest('[inert], [hidden], [aria-hidden="true"]') || window.getComputedStyle(trigger).visibility !== "visible") {
      dismiss();
      return;
    }
    if (text !== active.text) {
      active.text = text;
      tooltip.textContent = text;
    }
    const viewport = window.visualViewport;
    const position = positionTooltip(trigger.getBoundingClientRect(), tooltip.getBoundingClientRect(), {
      left: viewport?.offsetLeft ?? 0,
      top: viewport?.offsetTop ?? 0,
      width: viewport?.width ?? window.innerWidth,
      height: viewport?.height ?? window.innerHeight
    });
    tooltip.style.left = `${position.left}px`;
    tooltip.style.top = `${position.top}px`;
    tooltip.style.visibility = "visible";
    tooltip.dataset.side = position.side;
  }

  function show(trigger: Element, delay: number) {
    clearTimers();
    const text = trigger.getAttribute("data-tooltip")?.trim();
    if (!text) return dismiss();
    if (active?.trigger === trigger && active.text === text) return;
    dismiss();
    const open = () => {
      openTimer = undefined;
      if (!trigger.isConnected || !trigger.getClientRects().length) return;
      active = { trigger, text };
      tooltip.textContent = text;
      tooltip.style.visibility = "hidden";
      (document.fullscreenElement ?? document.body).append(tooltip);
      trigger.setAttribute("aria-describedby", tooltipDescription(trigger.getAttribute("aria-describedby"), tooltip.id, true)!);
      update();
      if (!active) return;
      document.dispatchEvent(new CustomEvent("cyberos:tooltip-open", { detail: tooltip.id }));
      observer.observe(document.body, { childList: true, subtree: true });
      for (let ancestor: Element | null = trigger; ancestor; ancestor = ancestor.parentElement) {
        ancestorObserver.observe(ancestor, { attributes: true, attributeFilter: ["data-tooltip", "class", "style", "hidden", "inert", "aria-hidden"] });
      }
      resizeObserver.observe(trigger);
      resizeObserver.observe(tooltip);
    };
    if (delay) openTimer = window.setTimeout(open, delay);
    else open();
  }

  function scheduleClose() {
    clearTimers();
    if (focused && !pointerFocus) show(focused, 0);
    else closeTimer = window.setTimeout(dismiss, 120);
  }

  function pointerOver(event: PointerEvent) {
    if (event.pointerType === "touch") return;
    if (event.target instanceof Node && tooltip.contains(event.target)) {
      clearTimers();
      return;
    }
    const next = triggerFor(event.target);
    if (next === hovered) return;
    hovered = next;
    if (next) show(next, 400);
    else scheduleClose();
  }

  function pointerOut(event: PointerEvent) {
    if (event.pointerType === "touch") return;
    if (event.relatedTarget instanceof Node && tooltip.contains(event.relatedTarget)) return;
    const next = triggerFor(event.relatedTarget);
    if (next && next === hovered) return;
    hovered = null;
    if (!next) scheduleClose();
  }

  function focusIn(event: FocusEvent) {
    focused = triggerFor(event.target);
    if (focused && !pointerFocus) show(focused, 0);
  }

  function focusOut(event: FocusEvent) {
    const next = triggerFor(event.relatedTarget);
    if (next === focused) return;
    focused = next;
    if (!hovered) scheduleClose();
  }

  function pointerDown(event: PointerEvent) {
    if (event.target instanceof Node && tooltip.contains(event.target)) return;
    pointerFocus = true;
    dismiss();
  }

  function keyDown(event: KeyboardEvent) {
    pointerFocus = false;
    if (event.key !== "Escape" || (!active && openTimer === undefined)) return;
    event.preventDefault();
    event.stopPropagation();
    dismiss();
    focused = null;
  }

  function scroll(event: Event) {
    if (event.target instanceof Node && tooltip.contains(event.target)) return;
    const trigger = active?.trigger ?? hovered ?? focused;
    if (event.target === document || (event.target instanceof Element && trigger && event.target.contains(trigger))) dismiss();
  }

  function otherTooltip(event: Event) {
    if (event instanceof CustomEvent && event.detail !== tooltip.id) dismiss();
  }

  document.addEventListener("pointerover", pointerOver, true);
  document.addEventListener("pointerout", pointerOut, true);
  document.addEventListener("pointerdown", pointerDown, true);
  document.addEventListener("focusin", focusIn, true);
  document.addEventListener("focusout", focusOut, true);
  document.addEventListener("keydown", keyDown, true);
  document.addEventListener("scroll", scroll, true);
  document.addEventListener("fullscreenchange", dismiss);
  document.addEventListener("astro:before-swap", dismiss);
  document.addEventListener("cyberos:tooltip-open", otherTooltip);
  window.addEventListener("resize", dismiss);
  window.addEventListener("blur", dismiss);
  window.addEventListener("hashchange", dismiss);
  window.addEventListener("popstate", dismiss);
  window.visualViewport?.addEventListener("resize", dismiss);
  window.visualViewport?.addEventListener("scroll", dismiss);
  return () => {
    dismiss();
    document.removeEventListener("pointerover", pointerOver, true);
    document.removeEventListener("pointerout", pointerOut, true);
    document.removeEventListener("pointerdown", pointerDown, true);
    document.removeEventListener("focusin", focusIn, true);
    document.removeEventListener("focusout", focusOut, true);
    document.removeEventListener("keydown", keyDown, true);
    document.removeEventListener("scroll", scroll, true);
    document.removeEventListener("fullscreenchange", dismiss);
    document.removeEventListener("astro:before-swap", dismiss);
    document.removeEventListener("cyberos:tooltip-open", otherTooltip);
    window.removeEventListener("resize", dismiss);
    window.removeEventListener("blur", dismiss);
    window.removeEventListener("hashchange", dismiss);
    window.removeEventListener("popstate", dismiss);
    window.visualViewport?.removeEventListener("resize", dismiss);
    window.visualViewport?.removeEventListener("scroll", dismiss);
  };
}
