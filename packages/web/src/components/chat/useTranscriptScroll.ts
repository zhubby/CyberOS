import { useLayoutEffect, useRef, type RefObject } from "react";
import type { TranscriptMessage } from "../../api.js";
import { useAppScroll, useMobileNavigation } from "../../mobile/MobileNavigation.js";

/** Position hydrated history before paint; keep following only while the reader is at the end. */
export function useTranscriptScroll(ref: RefObject<HTMLDivElement | null>, sessionId: string, active: boolean, latestMessage: TranscriptMessage | undefined) {
  const views = useMobileNavigation()?.views;
  const key = `agent:${sessionId}`;
  const following = useRef(true);
  const previousMessageId = useRef(latestMessage?.id);
  useAppScroll(ref, key, { ready: active });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !active) return;
    const saved = views?.get<number | null>(key, null);
    element.scrollTop = saved ?? element.scrollHeight;
    following.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 48;
    const onScroll = () => {
      following.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 48;
    };
    const observer = new ResizeObserver(() => {
      if (following.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", onScroll);
    };
  }, [active, key, ref, views]);

  useLayoutEffect(() => {
    // Sending a new prompt resumes following, even when it was composed while reading history.
    if (active && latestMessage?.role === "user" && latestMessage.id !== previousMessageId.current && ref.current) {
      following.current = true;
      ref.current.scrollTop = ref.current.scrollHeight;
    }
    previousMessageId.current = latestMessage?.id;
  }, [active, latestMessage, ref]);
}
