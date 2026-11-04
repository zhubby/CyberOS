import { useLayoutEffect, useRef, type RefObject } from "react";
import type { TranscriptMessage } from "../../api.js";
import { useMobileNavigation } from "../../mobile/MobileNavigation.js";

/** Position hydrated history before paint; keep following only while the reader is at the end. */
export function useTranscriptScroll(ref: RefObject<HTMLDivElement | null>, sessionId: string, active: boolean, latestMessage: TranscriptMessage | undefined, ready: boolean) {
  const views = useMobileNavigation()?.views;
  const key = `agent:${sessionId}`;
  const following = useRef(true);
  const previousMessageId = useRef(latestMessage?.id);
  const latestMessageRef = useRef(latestMessage);
  latestMessageRef.current = latestMessage;

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !active || !ready) return;
    const saved = views?.get<number | null>(key, null);
    element.scrollTop = saved ?? element.scrollHeight;
    let lastPosition = element.scrollTop;
    following.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 48;
    previousMessageId.current = latestMessageRef.current?.id;
    const onScroll = () => {
      lastPosition = element.scrollTop;
      views?.set(key, lastPosition);
      following.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 48;
    };
    const observer = new ResizeObserver(() => {
      if (following.current) {
        element.scrollTop = element.scrollHeight;
        lastPosition = element.scrollTop;
      }
    });
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      // Loading placeholders or detached nodes may already have clamped scrollTop.
      views?.set(key, lastPosition);
      observer.disconnect();
      element.removeEventListener("scroll", onScroll);
    };
  }, [active, key, ready, ref, views]);

  useLayoutEffect(() => {
    // Sending a new prompt resumes following, even when it was composed while reading history.
    if (!active || !ready) return;
    if (latestMessage?.role === "user" && latestMessage.id !== previousMessageId.current && ref.current) {
      following.current = true;
      ref.current.scrollTop = ref.current.scrollHeight;
    }
    previousMessageId.current = latestMessage?.id;
  }, [active, latestMessage, ready, ref]);
}
