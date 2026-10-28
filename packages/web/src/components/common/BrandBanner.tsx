interface BrandBannerProps {
  alt?: string;
}

export function BrandBanner({ alt = "" }: BrandBannerProps) {
  const decorative = alt.length === 0;

  return (
    <span
      className="brand-banner"
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : alt}
      aria-hidden={decorative || undefined}
    >
      <img className="brand-banner-mark" src="/cyberos-icon.svg" alt="" />
      <span className="brand-banner-wordmark" aria-hidden="true">CyberOS</span>
    </span>
  );
}
