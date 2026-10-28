import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandBanner } from "./BrandBanner.js";

describe("BrandBanner", () => {
  it("renders the shared mark and text wordmark with one accessible name", () => {
    const html = renderToStaticMarkup(createElement(BrandBanner, { alt: "CyberOS" }));

    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="CyberOS"');
    expect(html).toContain('src="/cyberos-icon.svg"');
    expect(html).toContain("CyberOS");
    expect(html.match(/alt=""/g)).toHaveLength(1);
  });

  it("stays hidden from assistive technology when decorative", () => {
    const html = renderToStaticMarkup(createElement(BrandBanner));

    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="img"');
    expect(html).not.toContain("aria-label");
  });
});
