import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observePinyinImeTooltip } from "./pinyin-ime-tooltip.js";
import type { PinyinImeElement } from "./pinyin-ime.js";

describe("TV input method tooltip adapter", () => {
  const observe = vi.fn();
  const disconnect = vi.fn();
  let notify: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("MutationObserver", class {
      constructor(callback: () => void) { notify = callback; }
      observe = observe;
      disconnect = disconnect;
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  function fixture() {
    const nativeAttributes = new Map([["title", "中文输入模式"], ["aria-label", "中文输入模式"]]);
    const hostAttributes = new Map<string, string>();
    const root = {
      querySelector: () => ({
        getAttribute: (name: string) => nativeAttributes.get(name) ?? null,
        removeAttribute: (name: string) => nativeAttributes.delete(name)
      })
    };
    const editor = {
      shadowRoot: root,
      setAttribute: (name: string, value: string) => hostAttributes.set(name, value),
      removeAttribute: (name: string) => hostAttributes.delete(name)
    } as unknown as PinyinImeElement;
    return { editor, root, nativeAttributes, hostAttributes };
  }

  it("replaces shadow input native titles with the shared host tooltip without removing its accessible name", () => {
    const { editor, root, nativeAttributes, hostAttributes } = fixture();
    observePinyinImeTooltip(editor);
    expect(hostAttributes.get("data-tooltip")).toBe("中文输入模式");
    expect(nativeAttributes.has("title")).toBe(false);
    expect(nativeAttributes.get("aria-label")).toBe("中文输入模式");
    expect(observe).toHaveBeenCalledWith(root, expect.objectContaining({ subtree: true, attributes: true }));
  });

  it("keeps mode changes and input rerenders synchronized", () => {
    const { editor, nativeAttributes, hostAttributes } = fixture();
    observePinyinImeTooltip(editor);
    nativeAttributes.set("title", "English input mode");
    nativeAttributes.set("aria-label", "English input mode");
    notify();
    expect(hostAttributes.get("data-tooltip")).toBe("English input mode");
    expect(nativeAttributes.has("title")).toBe(false);
    notify();
    expect(hostAttributes.get("data-tooltip")).toBe("English input mode");
  });

  it("removes observers and the host tooltip on teardown", () => {
    const { editor, hostAttributes } = fixture();
    const cleanup = observePinyinImeTooltip(editor);
    cleanup?.();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(hostAttributes.has("data-tooltip")).toBe(false);
  });

  it("clears stale mode help when the input method is disabled", () => {
    const { editor, nativeAttributes, hostAttributes } = fixture();
    observePinyinImeTooltip(editor);
    nativeAttributes.clear();
    notify();
    expect(hostAttributes.has("data-tooltip")).toBe(false);
  });

  it("does not attach an observer when no shadow root exists", () => {
    expect(observePinyinImeTooltip({ shadowRoot: null } as PinyinImeElement)).toBeUndefined();
    expect(observe).not.toHaveBeenCalled();
  });
});
