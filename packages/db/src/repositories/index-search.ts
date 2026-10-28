import { createHash } from "node:crypto";
import type {
  IndexSearchPage,
  IndexSearchRequest,
  IndexSearchResult,
  IndexSearchSortField
} from "@cyberos/shared";
import type { CyberOsDatabase } from "../connection.js";

export function queryIndexedText(
  db: CyberOsDatabase,
  input: { rootId: string; query: string; path?: string; limit?: number }
): Array<{
  fileId: string;
  path: string;
  name: string;
  snippet: string;
  sizeBytes: number | null;
  mtimeMs: number | null;
  mimeType: string | null;
}> {
  const searchPath = input.path ?? ".";
  const pathPattern = searchPath === "." ? null : `${searchPath}/%`;
  const contentState = db.prepare("SELECT status FROM index_content_state WHERE root_id = ?")
    .pluck().get(input.rootId) as string | undefined;
  const useNewOnly = contentState === "ready";
  const rows = db
    .prepare(`
      WITH matches AS (
        SELECT file_id, path, name,
          snippet(indexed_content_fts, 4, '<mark>', '</mark>', '...', 12) AS snippet
        FROM indexed_content_fts
        WHERE root_id = ? AND indexed_content_fts MATCH ?
        ${useNewOnly ? "" : `
          UNION ALL
          SELECT file_id, path, name,
            snippet(indexed_text, 4, '<mark>', '</mark>', '...', 12) AS snippet
          FROM indexed_text
          WHERE root_id = ? AND indexed_text MATCH ?
            AND file_id NOT IN (SELECT file_id FROM indexed_content_fts WHERE root_id = ?)
        `}
      )
      SELECT
        matches.file_id as fileId,
        matches.path,
        matches.name,
        matches.snippet,
        f.size_bytes AS sizeBytes,
        f.mtime_ms AS mtimeMs,
        f.mime_type AS mimeType
      FROM matches
      LEFT JOIN indexed_files f ON f.id = matches.file_id AND f.root_id = ?
      WHERE (
          ? IS NULL
          OR matches.path = ?
          OR substr(matches.path, 1, length(?) + 1) = ? || '/'
        )
      LIMIT ?
    `)
    .all(
      input.rootId,
      input.query,
      ...(useNewOnly ? [] : [input.rootId, input.query, input.rootId]),
      input.rootId,
      pathPattern,
      searchPath,
      searchPath,
      searchPath,
      input.limit ?? 25
    ) as Array<{
    fileId: string;
    path: string;
    name: string;
    snippet: string;
    sizeBytes: number | null;
    mtimeMs: number | null;
    mimeType: string | null;
  }>;

  return rows;
}

interface SearchCursor {
  version: 1;
  signature: string;
  sortValue: string | number;
  fileId: string;
}

interface AdvancedSearchRow {
  file_id: string;
  root_id: string;
  path: string;
  name: string;
  mime_type: string | null;
  size_bytes: number;
  mtime_ms: number;
  score: number | null;
  marked_snippet: string;
  extraction_source: IndexSearchResult["extractionSource"];
  extraction_status: IndexSearchResult["extractionStatus"];
  sort_value: string | number;
  content_match: number;
  content_match_count: number;
}

const HIGHLIGHT_START = "\u0001";
const HIGHLIGHT_END = "\u0002";
const MAX_FTS_CANDIDATES = 200;
const MAX_SNIPPET_MATCHES = 10;

export function queryIndexAdvanced(db: CyberOsDatabase, request: IndexSearchRequest): IndexSearchPage {
  const normalized = normalizeAdvancedRequest(request);
  const signature = createHash("sha256").update(JSON.stringify(normalized.signature)).digest("base64url");
  const cursor = decodeSearchCursor(normalized.cursor, signature);
  const parameters: unknown[] = [];
  const where: string[] = [];
  addAdvancedSearchFilters(where, parameters, "f", normalized);

  const sortExpression = searchSortExpression(normalized.sort.field);
  const direction = normalized.sort.direction === "asc" ? "ASC" : "DESC";
  if (cursor) {
    const comparison = direction === "ASC" ? ">" : "<";
    where.push(`(${sortExpression} ${comparison} ? OR (${sortExpression} = ? AND f.id ${comparison} ?))`);
    parameters.push(cursor.sortValue, cursor.sortValue, cursor.fileId);
  }

  let matchesSql = "";
  const matchParameters: unknown[] = [];
  let joinSql = "";
  let scoreSql = "NULL";
  const snippetSql = "''";
  if (normalized.filenameTerms.length && normalized.contentFtsQuery) {
    const contentState = db.prepare("SELECT status FROM index_content_state WHERE root_id = ?")
      .pluck().get(normalized.rootId) as string | undefined;
    const includeLegacy = contentState !== "ready";
    const candidateWhere: string[] = [];
    const candidateParameters: unknown[] = [];
    addAdvancedSearchFilters(candidateWhere, candidateParameters, "candidate_files", normalized);
    const candidateFilterSql = candidateWhere.join(" AND ");
    // Resolve FTS rowids through the lightweight shadow table so candidate scans do not decode stored bodies.
    matchesSql = `
      WITH
      filename_matches AS MATERIALIZED (
        SELECT candidate_files.id AS file_id, 1.0 AS score
        FROM indexed_files candidate_files
        WHERE ${candidateFilterSql}
          AND ${normalized.filenameTerms.map(() =>
            "(instr(lower(candidate_files.path), ?) > 0 OR instr(lower(candidate_files.name), ?) > 0)"
          ).join(" AND ")}
        LIMIT ?
      ),
      current_content_rows AS MATERIALIZED (
        SELECT rowid
        FROM indexed_content_fts
        WHERE indexed_content_fts MATCH ?
      ),
      current_content_matches AS MATERIALIZED (
        SELECT content.c0 AS file_id, 0.5 AS score
        FROM current_content_rows matched
        JOIN indexed_content_fts_content content ON content.id = matched.rowid
        JOIN indexed_files candidate_files
          ON candidate_files.id = content.c0
        WHERE ${candidateFilterSql}
        LIMIT ?
      )
      ${includeLegacy ? `,
      legacy_content_rows AS MATERIALIZED (
        SELECT rowid
        FROM indexed_text
        WHERE indexed_text MATCH ?
      ),
      legacy_content_matches AS MATERIALIZED (
        SELECT legacy_content.c0 AS file_id, 0.5 AS score
        FROM legacy_content_rows matched
        JOIN indexed_text_content legacy_content ON legacy_content.id = matched.rowid
        JOIN indexed_files candidate_files
          ON candidate_files.id = legacy_content.c0
        LEFT JOIN indexed_content_fts_content current_content
          ON current_content.c0 = legacy_content.c0
        WHERE ${candidateFilterSql}
          AND current_content.id IS NULL
        LIMIT ?
      )
      ` : ""},
      raw_matches AS (
        SELECT file_id, score, 0 AS content_match FROM filename_matches
        UNION ALL
        SELECT file_id, score, 1 AS content_match FROM current_content_matches
        ${includeLegacy ? `
          UNION ALL
          SELECT file_id, score, 1 AS content_match FROM legacy_content_matches
        ` : ""}
      ),
      matches AS MATERIALIZED (
        SELECT file_id, MAX(score) AS score, MAX(content_match) AS content_match
        FROM raw_matches
        GROUP BY file_id
      )`;
    matchParameters.push(
      ...candidateParameters,
      ...normalized.filenameTerms.flatMap((term) => [term, term]),
      MAX_FTS_CANDIDATES,
      normalized.contentFtsQuery, ...candidateParameters, MAX_FTS_CANDIDATES
    );
    if (includeLegacy) {
      matchParameters.push(
        normalized.legacyContentFtsQuery, ...candidateParameters, MAX_FTS_CANDIDATES
      );
    }
    joinSql = "JOIN matches m ON m.file_id = f.id";
    scoreSql = "m.score";
  }

  const sql = `
    ${matchesSql}
    SELECT f.id AS file_id, f.root_id, f.path, f.name, f.mime_type,
      f.size_bytes, f.mtime_ms, ${scoreSql} AS score,
      ${snippetSql} AS marked_snippet,
      f.extraction_source, f.extraction_status,
      ${sortExpression} AS sort_value,
      ${normalized.filenameTerms.length ? "m.content_match" : "0"} AS content_match,
      ${normalized.filenameTerms.length ? "(SELECT COUNT(*) FROM matches WHERE content_match = 1)" : "0"} AS content_match_count
    FROM indexed_files f
    ${joinSql}
    WHERE ${where.join(" AND ")}
    ORDER BY ${sortExpression} ${direction}, f.id ${direction}
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(
    ...matchParameters,
    ...parameters,
    normalized.limit + 1
  ) as AdvancedSearchRow[];
  const hasMore = rows.length > normalized.limit;
  const pageRows = hasMore ? rows.slice(0, normalized.limit) : rows;
  if (pageRows.length && pageRows[0]!.content_match_count <= MAX_SNIPPET_MATCHES) {
    const snippets = queryMarkedSnippets(
      db,
      normalized.rootId,
      normalized.contentFtsQuery,
      normalized.legacyContentFtsQuery,
      pageRows.filter((row) => row.content_match === 1).map((row) => row.file_id),
      normalized.filenameTerms.length ? db.prepare("SELECT status FROM index_content_state WHERE root_id = ?")
        .pluck().get(normalized.rootId) !== "ready" : false
    );
    for (const row of pageRows) row.marked_snippet = snippets.get(row.file_id) ?? "";
  }
  const files = pageRows.map(mapAdvancedSearchRow);
  const last = pageRows.at(-1);
  return {
    files,
    nextCursor: hasMore && last
      ? Buffer.from(JSON.stringify({
          version: 1,
          signature,
          sortValue: last.sort_value,
          fileId: last.file_id
        } satisfies SearchCursor)).toString("base64url")
      : null
  };
}

function normalizeAdvancedRequest(request: IndexSearchRequest) {
  const rootId = request.rootId.trim();
  const storagePoolId = request.storagePoolId.trim();
  if (!rootId || !storagePoolId) throw new Error("rootId and storagePoolId are required");
  const query = request.query?.normalize("NFKC").trim().toLocaleLowerCase() ?? "";
  if (query.length > 256) throw new Error("Search query must not exceed 256 characters");
  const path = normalizeSearchPath(request.path ?? ".");
  const limit = request.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Search limit must be an integer between 1 and 100");
  }
  const sort = { ...(request.sort ?? { field: "relevance" as const, direction: "desc" as const }) };
  if (!["relevance", "name", "mtime", "size"].includes(sort.field)) throw new Error("Unsupported search sort field");
  if (sort.direction !== "asc" && sort.direction !== "desc") throw new Error("Unsupported search sort direction");
  if (!query && sort.field === "relevance") sort.field = "name";
  const modifiedFromMs = parseDate(request.modifiedFrom, "modifiedFrom");
  const modifiedToMs = parseDate(request.modifiedTo, "modifiedTo");
  const sizeMin = optionalNonNegativeInteger(request.sizeMin, "sizeMin");
  const sizeMax = optionalNonNegativeInteger(request.sizeMax, "sizeMax");
  if (sizeMin !== null && sizeMax !== null && sizeMin > sizeMax) throw new Error("sizeMin must not exceed sizeMax");
  if (modifiedFromMs !== null && modifiedToMs !== null && modifiedFromMs > modifiedToMs) {
    throw new Error("modifiedFrom must not exceed modifiedTo");
  }
  const mimeTypes = normalizedList(request.mimeTypes);
  const categories = normalizedList(request.categories);
  const extractionSources = normalizedList(request.extractionSources);
  const extractionStatuses = normalizedList(request.extractionStatuses);
  const signature = {
    rootId, storagePoolId, path, query, mimeTypes, categories,
    modifiedFromMs, modifiedToMs, sizeMin, sizeMax,
    extractionSources, extractionStatuses, sort
  };
  return {
    ...signature,
    filenameTerms: query ? searchTokens(query) : [],
    contentFtsQuery: query ? literalFtsQuery(query, ["body", "terms"]) : null,
    legacyContentFtsQuery: query ? literalFtsQuery(query, ["body"]) : null,
    cursor: request.cursor ?? null,
    limit,
    signature
  };
}

function searchTokens(query: string): string[] {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (!tokens.length) throw new Error("Search query must contain a letter or number");
  return tokens;
}

function literalFtsQuery(query: string, columns: string[]): string {
  const tokens = searchTokens(query);
  const terms = tokens
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" AND ");
  return `{${columns.join(" ")}} : (${terms})`;
}

function queryMarkedSnippets(
  db: CyberOsDatabase,
  rootId: string,
  currentQuery: string | null,
  legacyQuery: string | null,
  fileIds: string[],
  includeLegacy: boolean
): Map<string, string> {
  const snippets = new Map<string, string>();
  if (!currentQuery || !legacyQuery || !fileIds.length) return snippets;
  const placeholders = fileIds.map(() => "?").join(", ");
  const current = db.prepare(`
    SELECT file_id, snippet(indexed_content_fts, 4, ?, ?, '...', 24) AS marked_snippet
    FROM indexed_content_fts
    WHERE root_id = ? AND indexed_content_fts MATCH ? AND file_id IN (${placeholders})
  `).all(HIGHLIGHT_START, HIGHLIGHT_END, rootId, currentQuery, ...fileIds) as Array<{
    file_id: string;
    marked_snippet: string;
  }>;
  for (const row of current) snippets.set(row.file_id, row.marked_snippet);
  if (!includeLegacy) return snippets;

  const missing = fileIds.filter((fileId) => !snippets.has(fileId));
  if (!missing.length) return snippets;
  const missingPlaceholders = missing.map(() => "?").join(", ");
  const legacy = db.prepare(`
    SELECT file_id, snippet(indexed_text, 4, ?, ?, '...', 24) AS marked_snippet
    FROM indexed_text
    WHERE root_id = ? AND indexed_text MATCH ? AND file_id IN (${missingPlaceholders})
  `).all(HIGHLIGHT_START, HIGHLIGHT_END, rootId, legacyQuery, ...missing) as Array<{
    file_id: string;
    marked_snippet: string;
  }>;
  for (const row of legacy) snippets.set(row.file_id, row.marked_snippet);
  return snippets;
}

function normalizeSearchPath(value: string): string {
  const path = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (!path || path === ".") return ".";
  if (path.startsWith("/") || path.split("/").some((segment) => !segment || segment === "..")) {
    throw new Error("Search path must be a normalized relative path");
  }
  return path;
}

function normalizedList<T extends string>(value: T[] | undefined): T[] {
  return [...new Set((value ?? []).map((item) => item.trim() as T).filter(Boolean))].sort();
}

function parseDate(value: string | undefined, name: string): number | null {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an ISO date`);
  return parsed;
}

function optionalNonNegativeInteger(value: number | undefined, name: string): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function addListFilter(where: string[], parameters: unknown[], expression: string, values: string[]): void {
  if (!values.length) return;
  where.push(`${expression} IN (${values.map(() => "?").join(", ")})`);
  parameters.push(...values);
}

function addAdvancedSearchFilters(
  where: string[],
  parameters: unknown[],
  alias: string,
  input: ReturnType<typeof normalizeAdvancedRequest>
): void {
  where.push(`${alias}.root_id = ?`);
  parameters.push(input.rootId);
  if (input.path !== ".") {
    where.push(`(${alias}.path = ? OR substr(${alias}.path, 1, length(?) + 1) = ? || '/')`);
    parameters.push(input.path, input.path, input.path);
  }
  addListFilter(where, parameters, `${alias}.mime_type`, input.mimeTypes);
  addListFilter(where, parameters, categorySql(alias), input.categories);
  addListFilter(where, parameters, `${alias}.extraction_source`, input.extractionSources);
  addListFilter(where, parameters, `${alias}.extraction_status`, input.extractionStatuses);
  if (input.modifiedFromMs !== null) {
    where.push(`${alias}.mtime_ms >= ?`);
    parameters.push(input.modifiedFromMs);
  }
  if (input.modifiedToMs !== null) {
    where.push(`${alias}.mtime_ms <= ?`);
    parameters.push(input.modifiedToMs);
  }
  if (input.sizeMin !== null) {
    where.push(`${alias}.size_bytes >= ?`);
    parameters.push(input.sizeMin);
  }
  if (input.sizeMax !== null) {
    where.push(`${alias}.size_bytes <= ?`);
    parameters.push(input.sizeMax);
  }
}

function categorySql(alias: string): string {
  return `CASE
    WHEN lower(COALESCE(${alias}.mime_type, '')) = 'application/pdf' THEN 'pdf'
    WHEN lower(COALESCE(${alias}.mime_type, '')) LIKE 'text/%' THEN 'text'
    WHEN lower(COALESCE(${alias}.mime_type, '')) LIKE '%wordprocessingml%' THEN 'document'
    WHEN lower(COALESCE(${alias}.mime_type, '')) LIKE '%spreadsheetml%' THEN 'spreadsheet'
    WHEN lower(COALESCE(${alias}.mime_type, '')) LIKE '%presentationml%' THEN 'presentation'
    ELSE 'other' END`;
}

function searchSortExpression(field: IndexSearchSortField): string {
  switch (field) {
    case "relevance": return "COALESCE(m.score, -1.0e308)";
    case "name": return "lower(f.name)";
    case "mtime": return "f.mtime_ms";
    case "size": return "f.size_bytes";
  }
}

function decodeSearchCursor(value: string | null, signature: string): SearchCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<SearchCursor>;
    if (
      parsed.version !== 1 || parsed.signature !== signature ||
      (typeof parsed.sortValue !== "string" && typeof parsed.sortValue !== "number") ||
      typeof parsed.fileId !== "string"
    ) throw new Error("invalid cursor");
    return parsed as SearchCursor;
  } catch {
    throw new Error("Search cursor does not match this query");
  }
}

function mapAdvancedSearchRow(row: AdvancedSearchRow): IndexSearchResult {
  const snippet = markedSnippetToPlainText(row.marked_snippet ?? "");
  return {
    fileId: row.file_id,
    rootId: row.root_id,
    path: row.path,
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    mtimeMs: row.mtime_ms,
    score: row.score,
    snippet: snippet.text,
    highlightRanges: snippet.ranges,
    extractionSource: row.extraction_source,
    extractionStatus: row.extraction_status
  };
}

function markedSnippetToPlainText(marked: string): { text: string; ranges: Array<{ start: number; end: number }> } {
  let text = "";
  let start: number | null = null;
  const ranges: Array<{ start: number; end: number }> = [];
  for (const character of marked) {
    if (character === HIGHLIGHT_START) {
      start = text.length;
    } else if (character === HIGHLIGHT_END) {
      if (start !== null && text.length > start) ranges.push({ start, end: text.length });
      start = null;
    } else {
      text += character;
    }
  }
  if (start !== null && text.length > start) ranges.push({ start, end: text.length });
  return { text, ranges };
}
