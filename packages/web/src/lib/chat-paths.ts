export interface WorkspaceMessagePath {
  displayPath: string;
  workspacePath: string;
}

export type MessagePathSegment =
  | { kind: "text"; value: string }
  | ({ kind: "path"; value: string } & WorkspaceMessagePath);

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
}

interface RemarkWorkspacePathsOptions {
  rootPath: string;
}

const SKIPPED_MARKDOWN_PARENTS = new Set(["code", "definition", "image", "inlineCode", "link", "linkReference"]);
const QUOTE_CHARACTERS = new Set(["\"", "'", "`"]);
const UNQUOTED_PATH_TERMINATOR = /[\s`"'<>|,;:!?()[\]{}\u3001\uff0c\u3002\uff1b\uff1a\uff01\uff1f\uff08\uff09\u3010\u3011\u3008\u3009\u300a\u300b]/u;
const TRAILING_SENTENCE_PUNCTUATION = /[.\u2026]+$/u;
const PATH_START_BLOCKER = /[\p{L}\p{N}_./-]/u;
const URI_SCHEME_SUFFIX = /[a-z][a-z\d+.-]*:$/iu;

export function resolveWorkspaceMessagePath(candidatePath: string, rootPath: string): WorkspaceMessagePath | null {
  const rawCandidate = candidatePath.replace(/\\/gu, "/").trim();
  if (rawCandidate.startsWith("//")) {
    return null;
  }

  const normalizedRoot = normalizeAbsolutePosixPath(rootPath);
  const normalizedCandidate = normalizeAbsolutePosixPath(rawCandidate);
  if (!normalizedRoot || !normalizedCandidate) {
    return null;
  }
  if (!pathTraversalStaysInsideRoot(rawCandidate, normalizedRoot)) {
    return null;
  }

  if (normalizedCandidate === normalizedRoot) {
    return {
      displayPath: candidatePath,
      workspacePath: "."
    };
  }

  const rootPrefix = normalizedRoot === "/" ? "/" : `${normalizedRoot}/`;
  if (!normalizedCandidate.startsWith(rootPrefix)) {
    return null;
  }

  return {
    displayPath: candidatePath,
    workspacePath: normalizedRoot === "/" ? normalizedCandidate.slice(1) || "." : normalizedCandidate.slice(rootPrefix.length)
  };
}

export function resolveWorkspaceMessageLink(href: string | undefined, rootPath: string): WorkspaceMessagePath | null {
  const rawHref = href?.trim() ?? "";
  if (!rawHref || rawHref.startsWith("//") || /^[a-z][a-z\d+.-]*:/iu.test(rawHref)) {
    return null;
  }

  const encodedPath = rawHref.split(/[?#]/u, 1)[0] ?? "";
  try {
    return resolveWorkspaceMessagePath(decodeURIComponent(encodedPath), rootPath);
  } catch {
    return null;
  }
}

export function splitWorkspaceMessagePaths(text: string, rootPath: string): MessagePathSegment[] {
  const normalizedRoot = normalizeAbsolutePosixPath(rootPath);
  if (!text || !normalizedRoot) {
    return [{ kind: "text", value: text }];
  }

  const segments: MessagePathSegment[] = [];
  let cursor = 0;
  let textStart = 0;

  while (cursor < text.length) {
    const pathStart = text.indexOf(normalizedRoot, cursor);
    if (pathStart < 0) {
      break;
    }
    if (!canStartPath(text, pathStart)) {
      cursor = pathStart + normalizedRoot.length;
      continue;
    }

    const quote = pathStart > 0 && QUOTE_CHARACTERS.has(text[pathStart - 1] ?? "") ? text[pathStart - 1] : null;
    const quotedEnd = quote ? text.indexOf(quote, pathStart) : -1;
    const lineStart = text.lastIndexOf("\n", pathStart - 1) + 1;
    const isStandaloneLinePath = text.slice(lineStart, pathStart).trim().length === 0;
    let pathEnd = quotedEnd >= 0 ? quotedEnd : isStandaloneLinePath ? unquotedLineEnd(text, pathStart) : unquotedPathEnd(text, pathStart);
    if (quotedEnd < 0) {
      const candidate = text.slice(pathStart, pathEnd);
      pathEnd -= candidate.length - candidate.replace(TRAILING_SENTENCE_PUNCTUATION, "").length;
    }

    const candidate = text.slice(pathStart, pathEnd);
    const resolved = resolveWorkspaceMessagePath(candidate, normalizedRoot);
    if (!resolved) {
      cursor = pathStart + normalizedRoot.length;
      continue;
    }

    if (pathStart > textStart) {
      segments.push({ kind: "text", value: text.slice(textStart, pathStart) });
    }
    segments.push({
      kind: "path",
      value: candidate,
      ...resolved
    });
    textStart = pathEnd;
    cursor = Math.max(pathEnd, pathStart + normalizedRoot.length);
  }

  if (!segments.length) {
    return [{ kind: "text", value: text }];
  }
  if (textStart < text.length) {
    segments.push({ kind: "text", value: text.slice(textStart) });
  }
  return segments;
}

export function workspaceParentPath(workspacePath: string): string {
  const segments = workspacePath.replace(/\\/gu, "/").split("/").filter(Boolean);
  return segments.slice(0, -1).join("/") || ".";
}

export function workspaceAbsolutePath(rootPath: string, workspacePath: string): string {
  const normalizedRoot = rootPath.replace(/\\/gu, "/").replace(/\/+$/u, "") || "/";
  const normalizedWorkspacePath = workspacePath.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
  if (!normalizedWorkspacePath || normalizedWorkspacePath === ".") {
    return normalizedRoot;
  }
  return normalizedRoot === "/" ? `/${normalizedWorkspacePath}` : `${normalizedRoot}/${normalizedWorkspacePath}`;
}

export function remarkWorkspacePaths({ rootPath }: RemarkWorkspacePathsOptions) {
  return (tree: MarkdownNode) => transformMarkdownTextNodes(tree, rootPath);
}

function transformMarkdownTextNodes(node: MarkdownNode, rootPath: string): void {
  if (!node.children || SKIPPED_MARKDOWN_PARENTS.has(node.type)) {
    return;
  }

  node.children = node.children.flatMap<MarkdownNode>((child): MarkdownNode | MarkdownNode[] => {
    if (child.type === "text" && typeof child.value === "string") {
      return splitWorkspaceMessagePaths(child.value, rootPath).map((segment) =>
        segment.kind === "path"
          ? { type: "inlineCode", value: segment.value }
          : { type: "text", value: segment.value }
      );
    }

    transformMarkdownTextNodes(child, rootPath);
    return child;
  });
}

function normalizeAbsolutePosixPath(rawPath: string): string | null {
  const normalized = rawPath.replace(/\\/gu, "/").trim();
  if (!normalized.startsWith("/")) {
    return null;
  }

  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (!segments.length) {
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return `/${segments.join("/")}`;
}

function pathTraversalStaysInsideRoot(candidatePath: string, normalizedRoot: string): boolean {
  if (normalizedRoot === "/") {
    return true;
  }

  const rootSegments = normalizedRoot.slice(1).split("/").filter(Boolean);
  const candidateSegments = candidatePath.split("/");
  const resolvedSegments: string[] = [];
  let enteredRoot = false;

  for (const segment of candidateSegments) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (!resolvedSegments.length) {
        return false;
      }
      resolvedSegments.pop();
    } else {
      resolvedSegments.push(segment);
    }

    const matchesRootPrefix =
      resolvedSegments.length <= rootSegments.length
        ? resolvedSegments.every((resolvedSegment, index) => resolvedSegment === rootSegments[index])
        : rootSegments.every((rootSegment, index) => resolvedSegments[index] === rootSegment);
    if (!matchesRootPrefix || (enteredRoot && resolvedSegments.length < rootSegments.length)) {
      return false;
    }
    if (resolvedSegments.length === rootSegments.length && matchesRootPrefix) {
      enteredRoot = true;
    }
  }

  return true;
}

function canStartPath(text: string, pathStart: number): boolean {
  if (pathStart === 0) {
    return true;
  }

  const previousCharacter = text[pathStart - 1] ?? "";
  if (PATH_START_BLOCKER.test(previousCharacter)) {
    return false;
  }
  return !URI_SCHEME_SUFFIX.test(text.slice(0, pathStart));
}

function unquotedPathEnd(text: string, pathStart: number): number {
  let pathEnd = pathStart;
  while (pathEnd < text.length && !UNQUOTED_PATH_TERMINATOR.test(text[pathEnd] ?? "")) {
    pathEnd += 1;
  }
  return pathEnd;
}

function unquotedLineEnd(text: string, pathStart: number): number {
  const remainingText = text.slice(pathStart);
  const lineBreakOffset = remainingText.search(/\r?\n/u);
  return lineBreakOffset < 0 ? text.length : pathStart + lineBreakOffset;
}
