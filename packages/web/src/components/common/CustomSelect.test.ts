import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CustomSelect } from "./CustomSelect.js";

describe("CustomSelect", () => {
  it("renders an accessible non-native trigger for a multi-value filter", () => {
    const html = renderToStaticMarkup(createElement(CustomSelect, {
      value: "",
      selectedValues: ["jpeg", "raw"],
      placeholder: "All media",
      options: [
        { value: "jpeg", label: "JPEG" },
        { value: "raw", label: "RAW" },
        { value: "video", label: "Video" }
      ],
      onChange: () => undefined
    }));

    expect(html).toContain('class="custom-select-value">All media</span>');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).not.toContain("<select");
  });
});
