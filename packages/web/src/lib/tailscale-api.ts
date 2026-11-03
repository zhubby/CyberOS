import {
  parseTailscaleStatus, type TailscaleStatus, type TailscaleActionInput, type TailscaleLoginInput,
  type TailscaleSettingsInput, type TailscaleServiceInput
} from "@cyberos/shared";

export class TailscaleApiError extends Error {
  constructor(readonly status: number) { super("Tailscale request failed"); }
}

async function request(path = "", method = "GET", body?: unknown): Promise<TailscaleStatus> {
  const response = await fetch(`/api/system/tailscale${path}`, {
    method, cache: "no-store",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  });
  if (!response.ok) throw new TailscaleApiError(response.status);
  const data: unknown = await response.json();
  const status = parseTailscaleStatus(typeof data === "object" && data !== null && "tailscale" in data ? data.tailscale : null);
  if (!status) throw new TailscaleApiError(502);
  return status;
}

export const getSystemTailscale = () => request();
export const loginSystemTailscale = (input: TailscaleLoginInput) => request("/login", "POST", input);
export const updateSystemTailscaleService = (input: TailscaleServiceInput) => request("/service", "PUT", input);
export const runSystemTailscaleAction = (input: TailscaleActionInput) => request("/actions", "POST", input);
export const updateSystemTailscaleSettings = (input: TailscaleSettingsInput) => request("/settings", "PUT", input);
export const finishSystemTailscaleApply = (id: string, action: "confirm" | "rollback") => request(`/apply/${encodeURIComponent(id)}/${action}`, "POST");
