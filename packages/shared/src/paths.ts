import path from "node:path";

/** Canonical persistent and volatile locations owned by CyberOS. */
export interface CyberOsPaths {
  rootDir: string;
  configDir: string;
  stateDir: string;
  logsDir: string;
  homeDir: string;
  dataRoot: string;
  backupRoot: string;
  appsRoot: string;
  isoRoot: string;
  vmRoot: string;
  deployRoot: string;
  systemBackupsDir: string;
  databasePath: string;
  metricsDatabasePath: string;
  defaultDataRoot: string;
  hostdStateDir: string;
  networkManagerStateDir: string;
  dockerStateDir: string;
  termuxHome: string;
  vodPlayerStateDir: string;
  runDir: string;
}

export function resolveCyberOsPaths(rootDir: string): CyberOsPaths {
  if (!path.isAbsolute(rootDir)) {
    throw new Error(`CyberOS root must be an absolute non-root directory: ${rootDir}`);
  }
  const root = path.resolve(rootDir);
  if (root === path.parse(root).root) {
    throw new Error(`CyberOS root must be an absolute non-root directory: ${rootDir}`);
  }

  const stateDir = path.join(root, "state");
  const dataRoot = path.join(root, "data");
  const hostdStateDir = path.join(stateDir, "hostd");
  return {
    rootDir: root,
    configDir: path.join(root, "config"),
    stateDir,
    logsDir: path.join(root, "logs"),
    homeDir: path.join(root, "home"),
    dataRoot,
    backupRoot: path.join(dataRoot, "backup"),
    appsRoot: path.join(root, "apps"),
    isoRoot: path.join(root, "iso"),
    vmRoot: path.join(root, "vm"),
    deployRoot: path.join(root, "deploy"),
    systemBackupsDir: path.join(root, "system-backups"),
    databasePath: path.join(stateDir, "cyberos.sqlite"),
    metricsDatabasePath: path.join(stateDir, "metrics.sqlite"),
    defaultDataRoot: path.join(dataRoot, "primary"),
    hostdStateDir,
    networkManagerStateDir: path.join(hostdStateDir, "network-manager"),
    dockerStateDir: path.join(hostdStateDir, "docker-daemon"),
    termuxHome: path.join(root, "home", "termux"),
    vodPlayerStateDir: path.join(stateDir, "vod-player"),
    runDir: "/run/cyberos"
  };
}

export function isPathInside(candidate: string, parent: string): boolean {
  const child = path.resolve(candidate);
  const base = path.resolve(parent);
  return child === base || child.startsWith(`${base}${path.sep}`);
}

export function assertPathInside(candidate: string, parent: string, label: string): string {
  const resolved = path.resolve(candidate);
  if (!isPathInside(resolved, parent)) {
    throw new Error(`${label} must be inside ${path.resolve(parent)}: ${candidate}`);
  }
  return resolved;
}
