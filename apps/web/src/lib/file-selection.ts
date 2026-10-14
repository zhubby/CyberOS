export type FileSelectionMode = "toggle" | "range";

export function updateFileSelection(
  current: ReadonlySet<string>,
  orderedPaths: readonly string[],
  targetPath: string,
  anchorPath: string | null,
  mode: FileSelectionMode
): Set<string> {
  if (mode === "toggle") {
    const next = new Set(current);
    if (next.has(targetPath)) next.delete(targetPath);
    else next.add(targetPath);
    return next;
  }

  const targetIndex = orderedPaths.indexOf(targetPath);
  const anchorIndex = anchorPath ? orderedPaths.indexOf(anchorPath) : -1;
  if (targetIndex < 0 || anchorIndex < 0) return new Set([targetPath]);
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return new Set(orderedPaths.slice(start, end + 1));
}

export function reconcileFileSelection(
  current: ReadonlySet<string>,
  availablePaths: ReadonlySet<string>
): Set<string> {
  return new Set([...current].filter((path) => availablePaths.has(path)));
}

export function isInvalidFileMoveDestination(
  entries: ReadonlyArray<{ path: string; name: string; kind: string }>,
  targetDirectory: string
): boolean {
  const normalizedTarget = normalizePath(targetDirectory);
  return entries.some((entry) => {
    const sourcePath = normalizePath(entry.path);
    const targetPath = normalizePath(`${normalizedTarget}/${entry.name}`);
    return targetPath === sourcePath || (
      entry.kind === "directory"
      && (normalizedTarget === sourcePath || normalizedTarget.startsWith(`${sourcePath}/`))
    );
  });
}

function normalizePath(value: string): string {
  const segments = value.replace(/\\/gu, "/").split("/").filter((segment) => segment && segment !== ".");
  return segments.join("/") || ".";
}
