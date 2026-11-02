import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const bootScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1] ?? "")
  .find((script) => script.includes('getElementById("cyberos-boot")'))!;

class BootElement extends EventTarget {
  dataset: Record<string, string> = {};
  textContent = "";
  attributes = new Map([["aria-busy", "true"]]);
  children = new Map<string, BootElement>();

  querySelector(selector: string): BootElement | null {
    return this.children.get(selector) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

function startBoot(language = "en") {
  vi.useFakeTimers();
  const screen = new BootElement();
  for (const name of ["title", "detail", "retry"]) {
    screen.children.set(`[data-boot-${name}]`, new BootElement());
  }
  const window = Object.assign(new EventTarget(), {
    setTimeout,
    clearTimeout,
    location: { href: "http://nas.local/?view=files#chat", replace: vi.fn() }
  });
  runInNewContext(bootScript, {
    window,
    document: { documentElement: { lang: language }, getElementById: () => screen },
    URL,
    Date
  });
  return { screen, window };
}

afterEach(() => vi.useRealTimers());

describe("boot screen", () => {
  it.each(["en", "zh-CN"])("keeps slow startup pending until the application is ready (%s)", (language) => {
    const { screen, window } = startBoot(language);

    vi.advanceTimersByTime(35_000);

    expect(screen.dataset.state).not.toBe("error");
    expect(screen.attributes.get("aria-busy")).toBe("true");
    window.dispatchEvent(new Event("cyberos:ready"));
    vi.advanceTimersByTime(60_000);
    expect(screen.dataset.state).not.toBe("error");
  });

  it("reports a real startup error and preserves it after the slow-load threshold", () => {
    const { screen, window } = startBoot();
    window.dispatchEvent(new Event("error"));
    vi.advanceTimersByTime(35_000);
    expect(screen.dataset.state).toBe("error");
    expect(screen.attributes.get("aria-busy")).toBe("false");
  });

  it("ignores startup errors and the timer after the application is ready", () => {
    const { screen, window } = startBoot();
    window.dispatchEvent(new Event("cyberos:ready"));
    window.dispatchEvent(new Event("error"));
    window.dispatchEvent(new Event("unhandledrejection"));
    vi.advanceTimersByTime(35_000);
    expect(screen.dataset.state).not.toBe("error");
  });

  it("lets the user reload without losing the current address", () => {
    const { screen, window } = startBoot();
    screen.querySelector("[data-boot-retry]")!.dispatchEvent(new Event("click"));
    const nextUrl = new URL(window.location.replace.mock.calls[0]![0]);
    expect(nextUrl.origin).toBe("http://nas.local");
    expect(nextUrl.searchParams.get("view")).toBe("files");
    expect(nextUrl.searchParams.has("_cyberos_reload")).toBe(true);
    expect(nextUrl.hash).toBe("#chat");
  });
});
