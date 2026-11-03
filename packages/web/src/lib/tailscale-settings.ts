import type { TailscaleSettings, TailscaleSettingsPatch, TailscaleStatus } from "@cyberos/shared";

export interface TailscaleDraft extends Omit<TailscaleSettings, "advertisedRoutes"> {
  routesText: string;
  revision: string;
  base: TailscaleSettings;
}

export function createTailscaleDraft(status: TailscaleStatus): TailscaleDraft {
  return { ...status.settings, routesText: status.settings.advertisedRoutes.join("\n"), revision: status.revision, base: status.settings };
}

export function tailscaleSettingsPatch(draft: TailscaleDraft): TailscaleSettingsPatch {
  const patch: TailscaleSettingsPatch = {};
  for (const key of ["hostname", "acceptDns", "acceptRoutes", "exitNodeId", "exitNodeAllowLanAccess", "advertiseExitNode"] as const) {
    if (draft[key] !== draft.base[key]) Object.assign(patch, { [key]: draft[key] });
  }
  const routes = [...new Set(draft.routesText.split(/[\s,]+/u).filter(Boolean))].sort();
  if (JSON.stringify(routes) !== JSON.stringify([...draft.base.advertisedRoutes].sort())) patch.advertisedRoutes = routes;
  return patch;
}

export function receiveTailscaleStatus(draft: TailscaleDraft | null, status: TailscaleStatus): TailscaleDraft {
  return draft && Object.keys(tailscaleSettingsPatch(draft)).length ? draft : createTailscaleDraft(status);
}
