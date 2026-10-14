import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandBanner } from "./BrandBanner.js";

describe("BrandBanner", () => {
  it("renders theme-specific artwork with one accessible name", () => {
    const html = renderToStaticMarkup(createElement(BrandBanner, { alt: "ZOS" }));

    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="ZOS"');
    expect(html).toContain('src="/zos-banner.svg"');
    expect(html).toContain('src="/zos-banner-light.svg"');
    expect(html.match(/alt=""/g)).toHaveLength(2);
  });

  it("stays hidden from assistive technology when decorative", () => {
    const html = renderToStaticMarkup(createElement(BrandBanner));

    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="img"');
    expect(html).not.toContain("aria-label");
  });
});
