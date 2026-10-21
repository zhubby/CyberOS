import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandBanner } from "./BrandBanner.js";

describe("BrandBanner", () => {
  it("renders the shared mark and text wordmark with one accessible name", () => {
    const html = renderToStaticMarkup(createElement(BrandBanner, { alt: "ZOS" }));

    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="ZOS"');
    expect(html).toContain('src="/zos-icon.svg"');
    expect(html).toContain("ZOS");
    expect(html.match(/alt=""/g)).toHaveLength(1);
  });

  it("stays hidden from assistive technology when decorative", () => {
    const html = renderToStaticMarkup(createElement(BrandBanner));

    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="img"');
    expect(html).not.toContain("aria-label");
  });
});
