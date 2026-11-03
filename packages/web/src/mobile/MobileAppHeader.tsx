import { ChevronLeft, Grid2X2 } from "lucide-react";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useMobileNavigation } from "./MobileNavigation.js";

export function useAppHeadingFocus() {
  const navigation = useMobileNavigation();
  const ref = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (!navigation?.compact) return;
    const frame = window.requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [navigation?.compact, navigation?.route]);
  return ref;
}

export function MobileAppControls({ control }: { control: "back" | "home" }) {
  const navigation = useMobileNavigation();
  const { t } = useTranslation();
  if (!navigation?.compact) return null;
  const back = control === "back";
  const label = t(back ? "mobile.back" : "mobile.home");
  const Icon = back ? ChevronLeft : Grid2X2;
  return <button
    type="button"
    className={back ? "mobile-app-back" : "mobile-app-home"}
    aria-label={label}
    data-tooltip={label}
    onClick={back ? navigation.goBack : navigation.goHome}
  >
    <Icon size={18} aria-hidden="true" />
    <span>{label}</span>
  </button>;
}

export function MobileAppHeader({ icon, title, subtitle, actions, meta, className, headingRef, titleId }: {
  icon: ReactNode;
  title: ReactNode;
  subtitle: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  className?: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  titleId?: string;
}) {
  return <header className={["management-header", "app-titlebar", "mobile-app-titlebar", className].filter(Boolean).join(" ")}>
    <span className="management-title-icon" aria-hidden="true">{icon}</span>
    <div className="management-title-copy">
      <h2 ref={headingRef} id={titleId} tabIndex={-1}>{title}</h2>
      <p>{subtitle}</p>
    </div>
    <div className="mobile-titlebar-toolbar">
      <MobileAppControls control="back" />
      {meta ? <div className="mobile-header-meta">{meta}</div> : null}
      {actions}
      <MobileAppControls control="home" />
    </div>
  </header>;
}
