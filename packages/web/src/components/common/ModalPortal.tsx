import { createContext, useContext, type ComponentPropsWithRef } from "react";
import { createPortal } from "react-dom";
import { MobileAppScope, useMobileBack, useMobileNavigation } from "../../mobile/MobileNavigation.js";

export const ModalDepthContext = createContext(0);

/** Popovers sit above their containing dialog and below the next modal layer. */
export function usePopoverBack(open: boolean, onClose: () => void, layer = 5) {
  const depth = useContext(ModalDepthContext);
  useMobileBack(() => { onClose(); return true; }, 90 + depth * 10 + layer, open);
}

export function ModalPortal({ children, className, style, onMouseDown, onClick, onRequestClose, closeDisabled = false, ...props }: ComponentPropsWithRef<"div"> & { onRequestClose?: () => void; closeDisabled?: boolean }) {
  const depth = useContext(ModalDepthContext);
  const navigation = useMobileNavigation();
  const scope = useContext(MobileAppScope);
  const visible = !navigation?.compact || !scope || navigation.route === scope;
  useMobileBack(() => {
    if (!closeDisabled) onRequestClose?.();
    return true;
  }, 100 + depth * 10, visible && Boolean(onRequestClose));
  if (!visible) return null;
  const content = (
    <ModalDepthContext.Provider value={depth + 1}>
      <div
        {...props}
        className={className}
        data-modal-layer={depth}
        style={{ ...style, zIndex: 100 + depth * 10 }}
        onMouseDown={(event) => {
          event.stopPropagation();
          onMouseDown?.(event);
        }}
        onClick={(event) => {
          event.stopPropagation();
          onClick?.(event);
        }}
      >
        {children}
      </div>
    </ModalDepthContext.Provider>
  );

  if (typeof document === "undefined") return content;
  const root = document.fullscreenElement
    ?? document.querySelector(".app-shell, .tv-library-shell")
    ?? document.body;
  return createPortal(content, root);
}
