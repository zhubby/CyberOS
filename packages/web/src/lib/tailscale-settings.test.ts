import { describe, expect, it } from "vitest";
import { unavailableTailscaleStatus } from "@cyberos/shared";
import { createTailscaleDraft, tailscaleSettingsPatch, receiveTailscaleStatus } from "./tailscale-settings.js";

describe("Tailscale settings drafts", () => {
  it("keeps the draft and base revision when live updates arrive during editing", () => {
    const initial = unavailableTailscaleStatus(null);
    initial.revision = "a".repeat(64);
    const draft = { ...createTailscaleDraft(initial), hostname: "new-name" };
    const updated = { ...initial, revision: "b".repeat(64), settings: { ...initial.settings, acceptDns: false } };
    const next = receiveTailscaleStatus(draft, updated);
    expect(next).toBe(draft);
    expect(tailscaleSettingsPatch(next)).toEqual({ hostname: "new-name" });
    expect(next.revision).toBe(initial.revision);
  });

  it("refreshes a clean draft and submits only explicitly changed fields", () => {
    const initial = unavailableTailscaleStatus(null);
    const updated = { ...initial, revision: "b".repeat(64), settings: { ...initial.settings, acceptDns: false } };
    const next = receiveTailscaleStatus(createTailscaleDraft(initial), updated);
    expect(next.revision).toBe(updated.revision);
    expect(next.acceptDns).toBe(false);
    expect(tailscaleSettingsPatch({ ...next, routesText: "192.168.20.0/24\nfd00::/64\n192.168.20.0/24" })).toEqual({ advertisedRoutes: ["192.168.20.0/24", "fd00::/64"] });
    expect(tailscaleSettingsPatch({ ...next, routesText: "\n" })).toEqual({});
  });
});
