import { describe, expect, it } from "vitest";
import { WORKSPACE_PANEL_IDS } from "../lib/workspace-panel-settings.js";
import { APP_REGISTRY, MOBILE_DOCK_APPS, MOBILE_GRID_APPS } from "./apps.js";
import { BackHandlerStack, formatMobileHash, parseMobileHash, ViewStateStore } from "./navigation.js";

describe("mobile app navigation", () => {
  it("opens known apps directly and sends malformed or unknown entries home", () => {
    expect(parseMobileHash("#/app/photos")).toBe("photos");
    expect(parseMobileHash("#/app/virtualMachines")).toBe("virtualMachines");
    for (const hash of ["", "#/home", "#/app/unknown", "#/app/%", "#/app/files/extra", "#/app/files?path=.."]) {
      expect(parseMobileHash(hash)).toBe("home");
    }
    expect(formatMobileHash("agent")).toBe("#/app/agent");
    expect(formatMobileHash("home")).toBe("#/home");
  });

  it("makes every existing panel, Agent, and settings reachable exactly once", () => {
    const ids = [...MOBILE_GRID_APPS, ...MOBILE_DOCK_APPS].map((app) => app.id);
    expect(new Set(ids)).toEqual(new Set([...WORKSPACE_PANEL_IDS, "agent", "settings"]));
    expect(ids).toHaveLength(14);
    expect(APP_REGISTRY).toHaveLength(14);
    expect(MOBILE_GRID_APPS.map((app) => app.id)).toEqual([
      "video", "downloads", "monitoring", "docker", "virtualMachines", "network", "storage", "shares", "terminal", "settings"
    ]);
    expect(MOBILE_DOCK_APPS.map((app) => app.id)).toEqual(["files", "photos", "music", "agent"]);
  });

  it("dismisses the top layer before leaving a detail and stops consuming after unregistering", () => {
    const stack = new BackHandlerStack();
    let detailOpen = true;
    let dialogOpen = true;
    const unregisterDetail = stack.add(() => {
      if (!detailOpen) return false;
      detailOpen = false;
      return true;
    }, 10);
    const unregisterDialog = stack.add(() => {
      if (!dialogOpen) return false;
      dialogOpen = false;
      return true;
    }, 100);
    expect(stack.consume()).toBe(true);
    expect(dialogOpen).toBe(false);
    expect(detailOpen).toBe(true);
    unregisterDialog();
    expect(stack.consume()).toBe(true);
    expect(detailOpen).toBe(false);
    unregisterDetail();
    expect(stack.consume()).toBe(false);
  });

  it("returns through nested dialogs from newest to oldest", () => {
    const stack = new BackHandlerStack();
    const closed: string[] = [];
    stack.add(() => { closed.push("parent"); return true; }, 100);
    const removeChild = stack.add(() => { closed.push("child"); return true; }, 110);
    stack.consume();
    removeChild();
    stack.consume();
    expect(closed).toEqual(["child", "parent"]);
  });

  it("restores independent app view snapshots without browser persistence", () => {
    const store = new ViewStateStore();
    store.set("photos:filters", { search: "holiday", sort: "captured_at" });
    store.set("files:scroll", 720);
    expect(store.get("photos:filters", { search: "", sort: "name" })).toEqual({ search: "holiday", sort: "captured_at" });
    expect(store.get("files:scroll", 0)).toBe(720);
    expect(store.get("music:query", "")).toBe("");
    expect(new ViewStateStore().get("files:scroll", 0)).toBe(0);
  });
});
