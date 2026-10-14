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
      <img className="brand-banner-art brand-banner-art-dark" src="/zos-banner.svg" alt="" />
      <img className="brand-banner-art brand-banner-art-light" src="/zos-banner-light.svg" alt="" />
    </span>
  );
}
