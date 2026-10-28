import type { AgentSessionRecord, NasRootRecord } from "@cyberos/shared";
import { listDir, previewFile, readText, searchFiles, statPath } from "@cyberos/nas-tools";
import { readOnlySystemPrompt } from "./system-prompt.js";

export interface AgentEmitEvent {
  type:
    | "agent.started"
    | "agent.message"
    | "agent.completed"
    | "agent.failed"
    | "tool_call.started"
    | "tool_call.completed"
    | "tool_call.failed";
  payload: Record<string, unknown>;
}

export interface ReadOnlyAgentInput {
  session: AgentSessionRecord;
  root: NasRootRecord;
  message: string;
  emit: (event: AgentEmitEvent) => void | Promise<void>;
  isCancelled?: () => boolean;
  queryIndex?: (query: string, path: string) => Promise<IndexMatch[]>;
}

export interface IndexMatch {
  fileId: string;
  path: string;
  name: string;
  snippet: string;
}

export interface AgentTurnResult {
  status: "completed" | "failed" | "cancelled";
  summary?: string;
  error?: string;
}

export async function runReadOnlyAgentTurn(input: ReadOnlyAgentInput): Promise<AgentTurnResult> {
  await input.emit({
    type: "agent.started",
    payload: {
      provider: "local-readonly-fallback",
      prompt: readOnlySystemPrompt
    }
  });

  if (isCancelled(input)) {
    return { status: "cancelled" };
  }

  if (isMutationRequest(input.message)) {
    return complete(
      input,
      "The local fallback is read-only and cannot modify files or create approval requests. No files were changed."
    );
  }

  const pathTool = extractPathTool(input.message);
  if (pathTool) {
    return runPathTool(input, pathTool);
  }

  const searchQuery = extractSearchQuery(input.message);
  if (searchQuery) {
    return runSearch(input, searchQuery);
  }

  return runDirectorySummary(input);
}

async function runDirectorySummary(input: ReadOnlyAgentInput): Promise<AgentTurnResult> {
  if (isCancelled(input)) {
    return { status: "cancelled" };
  }

  const toolCallId = crypto.randomUUID();
  await input.emit({
    type: "tool_call.started",
    payload: {
      id: toolCallId,
      name: "list_dir",
      input: {
        rootId: input.root.id,
        path: input.session.currentPath
      }
    }
  });

  try {
    const entries = await listDir(input.root, input.session.currentPath);
    if (isCancelled(input)) {
      return { status: "cancelled" };
    }

    await input.emit({
      type: "tool_call.completed",
      payload: {
        id: toolCallId,
        name: "list_dir",
        output: {
          count: entries.length,
          entries: entries.slice(0, 25)
        },
        shouldContinue: true
      }
    });

    const directories = entries.filter((entry) => entry.kind === "directory").length;
    const files = entries.filter((entry) => entry.kind === "file").length;
    const unsafe = entries.filter((entry) => !entry.isSafe).length;
    const names = entries.slice(0, 8).map((entry) => entry.name).join(", ");
    const pathLabel = input.session.currentPath === "." ? "root" : input.session.currentPath;
    const summary = [
      `Listed ${entries.length} items in ${pathLabel}.`,
      `${directories} folders, ${files} files${unsafe ? `, ${unsafe} unsafe symlink entries` : ""}.`,
      names ? `First items: ${names}.` : "The folder is empty."
    ].join(" ");

    return complete(input, summary);
  } catch (error) {
    return failTool(input, toolCallId, "list_dir", error);
  }
}

async function runSearch(input: ReadOnlyAgentInput, query: string): Promise<AgentTurnResult> {
  if (isCancelled(input)) {
    return { status: "cancelled" };
  }

  if (input.queryIndex) {
    const indexResult = await runIndexSearch(input, query);
    if (indexResult.status !== "completed" || indexResult.summary) {
      return indexResult;
    }
  }

  const toolCallId = crypto.randomUUID();
  await input.emit({
    type: "tool_call.started",
    payload: {
      id: toolCallId,
      name: "search_files",
      input: {
        rootId: input.root.id,
        path: input.session.currentPath,
        query
      }
    }
  });

  try {
    const matches = await searchFiles(input.root, {
      path: input.session.currentPath,
      query,
      limit: 25
    });
    if (isCancelled(input)) {
      return { status: "cancelled" };
    }

    await input.emit({
      type: "tool_call.completed",
      payload: {
        id: toolCallId,
        name: "search_files",
        output: {
          count: matches.length,
          matches
        },
        shouldContinue: true
      }
    });

    const summary = matches.length
      ? `Found ${matches.length} filename matches for "${query}": ${matches
          .slice(0, 8)
          .map((entry) => entry.path)
          .join(", ")}.`
      : `No filename matches found for "${query}" in ${input.session.currentPath}.`;
    return complete(input, summary);
  } catch (error) {
    return failTool(input, toolCallId, "search_files", error);
  }
}

async function runIndexSearch(input: ReadOnlyAgentInput, query: string): Promise<AgentTurnResult> {
  const toolCallId = crypto.randomUUID();
  await input.emit({
    type: "tool_call.started",
    payload: {
      id: toolCallId,
      name: "query_index",
      input: {
        rootId: input.root.id,
        query
      }
    }
  });

  try {
    const matches = await input.queryIndex!(query, input.session.currentPath);
    if (isCancelled(input)) {
      return { status: "cancelled" };
    }

    await input.emit({
      type: "tool_call.completed",
      payload: {
        id: toolCallId,
        name: "query_index",
        output: {
          count: matches.length,
          matches
        },
        shouldContinue: matches.length === 0
      }
    });

    if (!matches.length) {
      return { status: "completed" };
    }

    return complete(
      input,
      `Found ${matches.length} indexed matches for "${query}": ${matches
        .slice(0, 8)
        .map((match) => match.path)
        .join(", ")}.`
    );
  } catch (error) {
    return failTool(input, toolCallId, "query_index", error);
  }
}

async function runPathTool(
  input: ReadOnlyAgentInput,
  pathTool: { name: "stat_path" | "read_text" | "preview_file"; path: string }
): Promise<AgentTurnResult> {
  if (isCancelled(input)) {
    return { status: "cancelled" };
  }

  const toolCallId = crypto.randomUUID();
  await input.emit({
    type: "tool_call.started",
    payload: {
      id: toolCallId,
      name: pathTool.name,
      input: {
        rootId: input.root.id,
        path: pathTool.path
      }
    }
  });

  try {
    const output =
      pathTool.name === "stat_path"
        ? await statPath(input.root, pathTool.path)
        : pathTool.name === "read_text"
          ? await readText(input.root, pathTool.path)
          : await previewFile(input.root, pathTool.path);

    if (isCancelled(input)) {
      return { status: "cancelled" };
    }

    await input.emit({
      type: "tool_call.completed",
      payload: {
        id: toolCallId,
        name: pathTool.name,
        output,
        shouldContinue: true
      }
    });

    if ("content" in output) {
      return complete(
        input,
        `${pathTool.name === "preview_file" ? "Previewed" : "Read"} ${output.path}${output.truncated ? " (truncated)" : ""}.`
      );
    }

    return complete(
      input,
      `${output.path} is a ${output.kind}, ${output.sizeBytes} bytes, modified ${output.modifiedAt}.`
    );
  } catch (error) {
    return failTool(input, toolCallId, pathTool.name, error);
  }
}

async function complete(input: ReadOnlyAgentInput, summary: string): Promise<AgentTurnResult> {
  await input.emit({
    type: "agent.message",
    payload: {
      role: "assistant",
      content: summary
    }
  });
  await input.emit({
    type: "agent.completed",
    payload: {
      tool: "complete_task",
      summary,
      shouldContinue: false
    }
  });
  return { status: "completed", summary };
}

async function failTool(
  input: ReadOnlyAgentInput,
  toolCallId: string,
  toolName: string,
  error: unknown
): Promise<AgentTurnResult> {
  const message = error instanceof Error ? error.message : String(error);
  await input.emit({
    type: "tool_call.failed",
    payload: {
      id: toolCallId,
      name: toolName,
      error: message,
      shouldContinue: false
    }
  });
  await input.emit({
    type: "agent.failed",
    payload: {
      error: message
    }
  });
  return { status: "failed", error: message };
}

function extractSearchQuery(message: string): string | null {
  const quoted = message.match(/["'“”](.+?)["'“”]/u);
  if (quoted?.[1]) {
    return quoted[1].trim();
  }

  const searchMatch = message.match(/(?:search|find|look for|查找|搜索)\s+(.+)$/iu);
  if (searchMatch?.[1]) {
    return searchMatch[1].trim();
  }

  return null;
}

function extractPathTool(
  message: string
): { name: "stat_path" | "read_text" | "preview_file"; path: string } | null {
  const match = message.match(
    /^(stat|inspect|info|read|cat|preview|查看|读取|预览)\s+(.+)$/iu
  );
  if (!match?.[1] || !match[2]) {
    return null;
  }

  const verb = match[1].toLocaleLowerCase();
  const requestedPath = trimPath(match[2]);
  if (!requestedPath) {
    return null;
  }

  if (["stat", "inspect", "info", "查看"].includes(verb)) {
    return { name: "stat_path", path: requestedPath };
  }
  if (["preview", "预览"].includes(verb)) {
    return { name: "preview_file", path: requestedPath };
  }
  return { name: "read_text", path: requestedPath };
}

function isMutationRequest(message: string): boolean {
  return /\b(move|rename|copy|delete|remove|trash|restore|archive|mkdir|tag)\b|移动|重命名|复制|删除|移除|回收|恢复|归档|新建|创建目录/iu.test(
    message
  );
}

function trimPath(value: string): string {
  return value.trim().replace(/^["'“”]+|["'“”]+$/gu, "");
}

function isCancelled(input: ReadOnlyAgentInput): boolean {
  return input.isCancelled?.() ?? false;
}
