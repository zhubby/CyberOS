import { createContext, useContext, type ComponentPropsWithRef } from "react";
import { createPortal } from "react-dom";

const ModalDepthContext = createContext(0);

export function ModalPortal({ children, className, style, onMouseDown, onClick, ...props }: ComponentPropsWithRef<"div">) {
  const depth = useContext(ModalDepthContext);
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
