import { Activity, Bot, Container, Download, Files, HardDrive, Images, MonitorCog, MonitorPlay, Music2, Network, Settings, Share2, TerminalSquare, type LucideIcon } from "lucide-react";
import { WORKSPACE_PANEL_IDS, type WorkspacePanelId } from "../lib/workspace-panel-settings.js";

export type MobileAppId = WorkspacePanelId | "agent" | "settings";
export interface AppDefinition {
  id: MobileAppId;
  labelKey: `workspace.panels.${WorkspacePanelId}` | "mobile.agent" | "common.actions.systemSettings";
  shortLabelKey: `workspace.panels.${WorkspacePanelId}Short` | "mobile.agent" | "mobile.settings";
  Icon: LucideIcon;
}

function panel(id: WorkspacePanelId, Icon: LucideIcon): AppDefinition {
  return { id, Icon, labelKey: `workspace.panels.${id}`, shortLabelKey: `workspace.panels.${id}Short` };
}

export const APP_REGISTRY: readonly AppDefinition[] = [
  panel("files", Files), panel("photos", Images), panel("video", MonitorPlay), panel("music", Music2),
  panel("terminal", TerminalSquare), panel("downloads", Download), panel("monitoring", Activity),
  panel("docker", Container), panel("virtualMachines", MonitorCog), panel("network", Network),
  panel("storage", HardDrive), panel("shares", Share2),
  { id: "agent", Icon: Bot, labelKey: "mobile.agent", shortLabelKey: "mobile.agent" },
  { id: "settings", Icon: Settings, labelKey: "common.actions.systemSettings", shortLabelKey: "mobile.settings" }
];

export function isMobileAppId(value: string): value is MobileAppId {
  return APP_REGISTRY.some((app) => app.id === value);
}

export function isWorkspacePanelId(value: string): value is WorkspacePanelId {
  return (WORKSPACE_PANEL_IDS as readonly string[]).includes(value);
}

function apps(ids: readonly MobileAppId[]): readonly AppDefinition[] {
  return ids.map((id) => APP_REGISTRY.find((app) => app.id === id)!);
}

export const WORKSPACE_APPS = apps(WORKSPACE_PANEL_IDS) as readonly (AppDefinition & { id: WorkspacePanelId })[];
export const MOBILE_GRID_APPS = apps(["video", "downloads", "monitoring", "docker", "virtualMachines", "network", "storage", "shares", "terminal", "settings"]);
export const MOBILE_DOCK_APPS = apps(["files", "photos", "music", "agent"]);
