import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Play, X } from "lucide-react";
import { playbackMenuLayout } from "../../lib/playback-menu-layout.js";
import { PlaybackControls, PlaybackDetails, usePlaybackControls } from "./PlaybackControls.js";
import { PlaybackTargetSelect } from "./PlaybackTargetSelect.js";

export function PlaybackMenu({ onOpenBluetoothSettings }: { onOpenBluetoothSettings: () => void }) {
  const [open, setOpen] = useState(false);
  const c = usePlaybackControls(open);
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLElement>(null);
  const [layout, setLayout] = useState<ReturnType<typeof playbackMenuLayout>>();
  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (c.p.fullscreen || c.p.playerOpen || c.music.drawerOpen) close();
  }, [c.p.fullscreen, c.p.playerOpen, c.music.drawerOpen, close]);

  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) close();
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      close(true);
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, close]);

  useLayoutEffect(() => {
    if (!open) return;
    function updateLayout() {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const anchor = trigger.getBoundingClientRect();
      if (!anchor.width || !anchor.height) { close(); return; }
      const viewport = window.visualViewport ?? { width: window.innerWidth, height: window.innerHeight };
      const next = playbackMenuLayout(anchor, viewport, menu.scrollHeight + menu.offsetHeight - menu.clientHeight);
      setLayout((current) => current && Object.keys(next).every((key) => current[key as keyof typeof next] === next[key as keyof typeof next]) ? current : next);
    }
    function scroll(event: Event) {
      if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) updateLayout();
    }
    updateLayout();
    (menuRef.current?.querySelector<HTMLElement>("[data-playback-primary]:not(:disabled)") ?? menuRef.current)?.focus({ preventScroll: true });
    const observer = new ResizeObserver(updateLayout);
    if (triggerRef.current) observer.observe(triggerRef.current);
    if (menuRef.current) observer.observe(menuRef.current);
    window.addEventListener("resize", updateLayout);
    document.addEventListener("scroll", scroll, true);
    window.visualViewport?.addEventListener("resize", updateLayout);
    window.visualViewport?.addEventListener("scroll", updateLayout);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateLayout);
      document.removeEventListener("scroll", scroll, true);
      window.visualViewport?.removeEventListener("resize", updateLayout);
      window.visualViewport?.removeEventListener("scroll", updateLayout);
    };
  }, [open, close]);

  const label = `${c.t("playback.open")} · ${c.t(`playback.state.${c.state}`)}`;
  return <>
    <button ref={triggerRef} type="button" className="settings-button agent-settings-button agent-playback-button"
      data-playback-state={c.state} aria-label={label} data-tooltip={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen((current) => !current)}>
      <Play size={18} aria-hidden="true" />
    </button>
    <PlaybackDetails c={c} onOpenBluetoothSettings={onOpenBluetoothSettings} />
    {open ? createPortal(
      <section id={id} ref={menuRef} tabIndex={-1} className="playback-menu" role="dialog" aria-label={c.t("playback.nowPlaying")} style={layout}>
        <header>
          <PlaybackTargetSelect />
          <span className="playback-menu-state" data-playback-state={c.state}>{c.t(`playback.state.${c.state}`)}</span>
          <button className="icon-button" type="button" aria-label={c.t("common.actions.close")} data-tooltip={c.t("common.actions.close")} onClick={() => close(true)}><X size={18} aria-hidden="true" /></button>
        </header>
        <PlaybackControls c={c} variant="menu" beforeDetails={() => close(true)} />
      </section>, document.querySelector(".app-shell") ?? document.body
    ) : null}
  </>;
}
