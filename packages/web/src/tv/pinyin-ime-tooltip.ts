import type { PinyinImeElement } from "./pinyin-ime.js";

export function observePinyinImeTooltip(editor: PinyinImeElement) {
  const root = editor.shadowRoot;
  if (!root) return;
  const sync = () => {
    const input = root.querySelector("input, textarea");
    const label = input?.getAttribute("title") ?? input?.getAttribute("aria-label");
    if (label) editor.setAttribute("data-tooltip", label);
    else editor.removeAttribute("data-tooltip");
    input?.removeAttribute("title");
  };
  const observer = new MutationObserver(sync);
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["title", "aria-label"] });
  sync();
  return () => {
    observer.disconnect();
    editor.removeAttribute("data-tooltip");
  };
}
