import { useContext, useEffect, useRef, type RefObject } from "react";
import { ModalDepthContext } from "../common/ModalPortal.js";
import { useMobileBack } from "../../mobile/MobileNavigation.js";
import { isBackKey } from "../../lib/remote-keys.js";

export function closeModalForHome(dialog: HTMLElement): boolean {
  return dialog.dispatchEvent(new Event("cyberos:modal-home", { cancelable: true }));
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

export function useModalDialog(onClose: () => void, closeDisabled = false, active = true): RefObject<HTMLElement | null> {
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);
  const depth = useContext(ModalDepthContext);
  useMobileBack(() => {
    if (!closeDisabledRef.current) onCloseRef.current();
    return true;
  }, 100 + depth * 10, active);

  useEffect(() => {
    onCloseRef.current = onClose;
    closeDisabledRef.current = closeDisabled;
  }, [closeDisabled, onClose]);

  useEffect(() => {
    if (!active) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let restoreFocus = true;
    const returnMenu = previouslyFocused?.closest<HTMLElement>("[data-focus-return]")?.dataset.focusReturn;
    const returnTarget = returnMenu ? [...document.querySelectorAll<HTMLButtonElement>("button[aria-controls]")].find((button) => button.getAttribute("aria-controls") === returnMenu) : null;
    const frame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (dialog && !dialog.contains(document.activeElement)) dialog.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || topmostModal() !== dialog) return;
      if (isBackKey(event)) {
        event.preventDefault();
        event.stopPropagation();
        if (!closeDisabledRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
        .filter((element) => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true");
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (!(document.activeElement instanceof Node) || !dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const handleHome = (event: Event) => {
      if (closeDisabledRef.current) { event.preventDefault(); return; }
      restoreFocus = false;
      onCloseRef.current();
    };
    const dialog = dialogRef.current;
    dialog?.addEventListener("cyberos:modal-home", handleHome);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      dialog?.removeEventListener("cyberos:modal-home", handleHome);
      const target = previouslyFocused?.isConnected ? previouslyFocused : returnTarget;
      if (restoreFocus && target?.isConnected) window.requestAnimationFrame(() => { if (target.getClientRects().length) target.focus(); });
    };
  }, [active]);

  return dialogRef;
}

function topmostModal(): HTMLElement | null {
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')]
    .filter((dialog) => dialog.isConnected && dialog.getClientRects().length > 0);
  return dialogs.at(-1) ?? null;
}
