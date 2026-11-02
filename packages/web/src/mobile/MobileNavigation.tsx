import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from "react";
import type { MobileAppId } from "./apps.js";
import { BackHandlerStack, formatMobileHash, parseMobileHash, ViewStateStore, type MobileRoute } from "./navigation.js";

interface MobileNavigation {
  compact: boolean;
  route: MobileRoute;
  lastApp: MobileAppId | null;
  openApp: (app: MobileAppId) => void;
  goHome: () => void;
  goBack: () => void;
  ensureBackEntry: () => void;
  handlers: BackHandlerStack;
  views: ViewStateStore;
}

const NavigationContext = createContext<MobileNavigation | null>(null);
export const MobileAppScope = createContext<MobileAppId | null>(null);
const HISTORY_KEY = "cyberosMobileIndex";

function historyIndex(): number {
  const value: unknown = window.history.state?.[HISTORY_KEY];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function writeHistory(index: number, route: MobileRoute, replace: boolean) {
  const state: Record<string, unknown> = { [HISTORY_KEY]: index };
  if (replace) window.history.replaceState(state, "", formatMobileHash(route));
  else window.history.pushState(state, "", formatMobileHash(route));
}

export function MobileNavigationProvider({ children }: { children: ReactNode }) {
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 1040px)").matches);
  const [route, setRoute] = useState<MobileRoute>(() => typeof window === "undefined" ? "home" : parseMobileHash(window.location.hash));
  const [lastApp, setLastApp] = useState<MobileAppId | null>(null);
  const routeRef = useRef(route);
  const compactRef = useRef(compact);
  const indexRef = useRef(0);
  const handlers = useRef(new BackHandlerStack()).current;
  const views = useRef(new ViewStateStore()).current;
  compactRef.current = compact;

  const applyRoute = useCallback((next: MobileRoute) => {
    if (routeRef.current !== "home") setLastApp(routeRef.current);
    routeRef.current = next;
    setRoute(next);
  }, []);

  const navigate = useCallback((next: MobileRoute) => {
    if (next === routeRef.current) return;
    if (compactRef.current) writeHistory(++indexRef.current, next, false);
    applyRoute(next);
  }, [applyRoute]);

  const goBack = useCallback(() => {
    if (handlers.consume()) return;
    if (compactRef.current && indexRef.current > 0) window.history.back();
    else navigate("home");
  }, [handlers, navigate]);

  const ensureBackEntry = useCallback(() => {
    if (compactRef.current && indexRef.current === 0) {
      if (window.history.state?.[HISTORY_KEY] === undefined && routeRef.current !== "home") {
        writeHistory(0, "home", true);
      }
      writeHistory(1, routeRef.current, false);
      indexRef.current = 1;
    }
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1040px)");
    const sync = () => setCompact(media.matches);
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!compact) return;
    indexRef.current = historyIndex();
    if (window.history.state?.[HISTORY_KEY] === undefined && routeRef.current !== "home") {
      writeHistory(0, "home", true);
      writeHistory(1, routeRef.current, false);
      indexRef.current = 1;
    } else writeHistory(indexRef.current, routeRef.current, true);
  }, [compact]);

  useEffect(() => {
    const pop = () => {
      if (compactRef.current && historyIndex() < indexRef.current && handlers.consume()) {
        writeHistory(indexRef.current, routeRef.current, false);
        return;
      }
      indexRef.current = historyIndex();
      const next = parseMobileHash(window.location.hash);
      if (window.location.hash !== formatMobileHash(next)) writeHistory(indexRef.current, next, true);
      applyRoute(next);
    };
    const hash = () => {
      if (window.location.hash === formatMobileHash(routeRef.current)) return;
      const next = parseMobileHash(window.location.hash);
      if (compactRef.current) writeHistory(++indexRef.current, next, true);
      applyRoute(next);
    };
    window.addEventListener("popstate", pop);
    window.addEventListener("hashchange", hash);
    return () => {
      window.removeEventListener("popstate", pop);
      window.removeEventListener("hashchange", hash);
    };
  }, [applyRoute, handlers]);

  useEffect(() => {
    if (!compact) return;
    const viewport = window.visualViewport;
    const sync = () => {
      document.documentElement.style.setProperty("--mobile-viewport-height", `${viewport?.height ?? window.innerHeight}px`);
      document.documentElement.style.setProperty("--mobile-viewport-top", `${viewport?.offsetTop ?? 0}px`);
    };
    sync();
    viewport?.addEventListener("resize", sync);
    viewport?.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);
    return () => {
      viewport?.removeEventListener("resize", sync);
      viewport?.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
      document.documentElement.style.removeProperty("--mobile-viewport-height");
      document.documentElement.style.removeProperty("--mobile-viewport-top");
    };
  }, [compact]);

  return <NavigationContext.Provider value={{ compact, route, lastApp, openApp: navigate, goHome: () => navigate("home"), goBack, ensureBackEntry, handlers, views }}>{children}</NavigationContext.Provider>;
}

export function useMobileNavigation() {
  return useContext(NavigationContext);
}

export function useMobileBack(handle: () => boolean, priority = 10, enabled = true) {
  const navigation = useMobileNavigation();
  const scope = useContext(MobileAppScope);
  const handleRef = useRef(handle);
  handleRef.current = handle;
  const active = enabled && navigation?.compact && (!scope || scope === navigation.route);
  useEffect(() => {
    if (!active || !navigation) return;
    navigation.ensureBackEntry();
    return navigation.handlers.add(() => handleRef.current(), priority);
  }, [active, navigation?.handlers, navigation?.ensureBackEntry, priority]);
}

export function useAppViewState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const views = useMobileNavigation()?.views;
  const [value, setValue] = useState<T>(() => {
    const fallback = typeof initial === "function" ? (initial as () => T)() : initial;
    return views?.get(key, fallback) ?? fallback;
  });
  useEffect(() => { views?.set(key, value); }, [key, value, views]);
  return [value, setValue];
}

/** Restores after asynchronous rows arrive, fetching further pages when necessary. */
export function useAppScroll(ref: RefObject<HTMLElement | null>, key: string, { ready = true, canLoadMore = false, loadMore }: { ready?: boolean; canLoadMore?: boolean; loadMore?: () => void | Promise<void> } = {}) {
  const views = useMobileNavigation()?.views;
  const options = useRef({ ready, canLoadMore, loadMore });
  options.current = { ready, canLoadMore, loadMore };
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !views) return;
    const target = views.get(key, 0);
    let restoring = target > 0;
    let fetching = false;
    let frame = 0;
    let disposed = false;
    const restore = () => {
      if (disposed || !restoring || !options.current.ready) return;
      element.scrollTop = target;
      if (element.scrollHeight - element.clientHeight >= target) restoring = false;
      else if (options.current.canLoadMore && options.current.loadMore) {
        if (!fetching) {
          fetching = true;
          void Promise.resolve(options.current.loadMore()).catch(() => { restoring = false; }).finally(() => {
            fetching = false;
            if (!disposed) frame = window.requestAnimationFrame(restore);
          });
        }
      } else restoring = false;
    };
    const save = () => { if (!restoring) views.set(key, element.scrollTop); };
    const cancel = () => { restoring = false; save(); };
    const changed = () => { window.cancelAnimationFrame(frame); frame = window.requestAnimationFrame(restore); };
    const observer = new MutationObserver(changed);
    observer.observe(element, { childList: true, subtree: true });
    element.addEventListener("scroll", save, { passive: true });
    element.addEventListener("pointerdown", cancel, { passive: true });
    element.addEventListener("wheel", cancel, { passive: true });
    frame = window.requestAnimationFrame(restore);
    return () => {
      disposed = true;
      // Detached scroll containers report zero in Chromium; retain the last scroll event.
      if (element.isConnected) views.set(key, restoring ? target : element.scrollTop);
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      element.removeEventListener("scroll", save);
      element.removeEventListener("pointerdown", cancel);
      element.removeEventListener("wheel", cancel);
    };
  }, [key, ref, views, ready]);
}
