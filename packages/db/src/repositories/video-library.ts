import { randomUUID, createHash } from "node:crypto";
import type {
  MediaCollection,
  MediaPersonalState,
  MediaProgressRecord,
  VideoHome,
  VideoPage,
  VideoQuery,
  VideoTitle,
  VideoTitleDetail,
} from "@cyberos/shared";
import type { CyberOsDatabase } from "../connection.js";
import {
  getMediaHome,
  getMediaTitle,
  getMediaTitleSummary,
} from "./media-library.js";

const watchedExpression = `COALESCE(p.watched,CASE WHEN t.kind='series' THEN
  EXISTS(SELECT 1 FROM media_episodes e JOIN media_seasons s ON s.id=e.season_id WHERE e.title_id=t.id AND s.season_number>0)
  AND NOT EXISTS(SELECT 1 FROM media_episodes e JOIN media_seasons s ON s.id=e.season_id LEFT JOIN media_episode_state es ON es.episode_id=e.id WHERE e.title_id=t.id AND s.season_number>0 AND COALESCE(es.watched,(SELECT MAX(mp.completed) FROM media_files f JOIN media_progress mp ON mp.file_id=f.id AND mp.profile_id='local-admin' WHERE f.episode_id=e.id),0)=0)
  ELSE (SELECT MAX(completed) FROM media_progress WHERE profile_id='local-admin' AND file_id IN(SELECT id FROM media_files WHERE title_id=t.id)) END,0)`;
function isWatched(db: CyberOsDatabase, id: string): boolean {
  return !!(
    db
      .prepare(
        `SELECT ${watchedExpression} AS watched FROM media_titles t LEFT JOIN media_personal_state p ON p.title_id=t.id WHERE t.id=?`,
      )
      .get(id) as { watched: number } | undefined
  )?.watched;
}

export function getVideoTitle(
  db: CyberOsDatabase,
  id: string,
): VideoTitleDetail | null {
  const title = getMediaTitle(db, id);
  if (!title) return null;
  const state = db
    .prepare("SELECT * FROM media_personal_state WHERE title_id=?")
    .get(id) as
    { favorite: number; watchlist: number; watched: number | null } | undefined;
  const meta = db
    .prepare("SELECT * FROM media_title_metadata WHERE title_id=?")
    .get(id) as { rating: number | null; credits_json: string } | undefined;
  const fileProgress: Record<string, MediaProgressRecord> = {};
  const rows = db
    .prepare(
      "SELECT p.* FROM media_progress p JOIN media_files f ON f.id=p.file_id WHERE f.title_id=? AND p.profile_id='local-admin'",
    )
    .all(id) as Array<{
    file_id: string;
    position_seconds: number;
    duration_seconds: number | null;
    completed: number;
    updated_at: string;
  }>;
  for (const p of rows)
    fileProgress[p.file_id] = {
      fileId: p.file_id,
      profileId: "local-admin",
      positionSeconds: p.position_seconds,
      durationSeconds: p.duration_seconds,
      completed: !!p.completed,
      updatedAt: p.updated_at,
    };
  const technical = Object.fromEntries(
    (
      db
        .prepare(
          "SELECT x.file_id,x.probe_json FROM media_file_technical x JOIN media_files f ON f.id=x.file_id WHERE f.title_id=? AND x.identity=CAST(f.size_bytes AS TEXT)||':'||CAST(f.mtime_ms AS TEXT)",
        )
        .all(id) as Array<{ file_id: string; probe_json: string }>
    ).map((row) => [
      row.file_id,
      (
        JSON.parse(row.probe_json) as {
          tracks: VideoTitleDetail["technical"][string];
        }
      ).tracks,
    ]),
  );
  const nextFileId = title.progress?.completed
    ? (getNextVideoFile(db, title.progress.fileId)?.fileId ?? null)
    : null;
  const episodeWatched = Object.fromEntries(
    (
      db
        .prepare(
          "SELECT s.episode_id,s.watched FROM media_episode_state s JOIN media_episodes e ON e.id=s.episode_id WHERE e.title_id=?",
        )
        .all(id) as Array<{ episode_id: string; watched: number }>
    ).map((e) => [e.episode_id, !!e.watched]),
  );
  return {
    ...title,
    watched: isWatched(db, id),
    personal: {
      favorite: !!state?.favorite,
      watchlist: !!state?.watchlist,
      watched: state?.watched == null ? null : !!state.watched,
    },
    rating: meta?.rating ?? null,
    credits: meta
      ? (JSON.parse(meta.credits_json) as VideoTitle["credits"])
      : [],
    fileProgress,
    episodeWatched,
    technical,
    nextFileId,
  };
}

export function saveMediaState(
  db: CyberOsDatabase,
  id: string,
  patch: Partial<MediaPersonalState>,
): MediaPersonalState {
  if (
    !patch ||
    typeof patch !== "object" ||
    Array.isArray(patch) ||
    Object.keys(patch).some(
      (k) => !["favorite", "watchlist", "watched"].includes(k),
    )
  )
    throw new Error("Invalid media state");
  const title = getVideoTitle(db, id);
  if (!title) throw new Error("Media title not found");
  for (const key of ["favorite", "watchlist", "watched"] as const) {
    if (
      patch[key] !== undefined &&
      typeof patch[key] !== "boolean" &&
      !(key === "watched" && patch[key] === null)
    )
      throw new Error("Invalid media state");
  }
  const state = { ...title.personal, ...patch };
  db.prepare(
    "INSERT INTO media_personal_state VALUES(?,?,?,?,?) ON CONFLICT(title_id) DO UPDATE SET favorite=excluded.favorite,watchlist=excluded.watchlist,watched=excluded.watched,updated_at=excluded.updated_at",
  ).run(
    id,
    +state.favorite,
    +state.watchlist,
    state.watched === null ? null : +state.watched,
    new Date().toISOString(),
  );
  return state;
}
export function saveEpisodeWatched(
  db: CyberOsDatabase,
  id: string,
  watched: boolean,
): void {
  if (
    typeof watched !== "boolean" ||
    !db.prepare("SELECT id FROM media_episodes WHERE id=?").get(id)
  )
    throw new Error("Episode not found or invalid state");
  db.prepare(
    "INSERT INTO media_episode_state VALUES(?,?,?) ON CONFLICT(episode_id) DO UPDATE SET watched=excluded.watched,updated_at=excluded.updated_at",
  ).run(id, +watched, new Date().toISOString());
}

export function listVideoTitles(
  db: CyberOsDatabase,
  input: VideoQuery = {},
): VideoPage {
  const { cursor, limit: requestedLimit, ...filter } = input;
  const sort = input.sort ?? "title";
  const orders = {
    title: "t.sort_title",
    year: "COALESCE(t.year,0)",
    added: "t.added_at",
    rating: "COALESCE(m.rating,0)",
    recent:
      "COALESCE((SELECT MAX(updated_at) FROM media_progress WHERE file_id IN(SELECT id FROM media_files WHERE title_id=t.id)),'')",
  };
  const order = orders[sort];
  if (!order) throw new Error("Invalid sort");
  const descending = sort !== "title";
  const limit = Math.min(100, Math.max(1, Math.floor(requestedLimit ?? 40)));
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(Object.entries(filter).sort()))
    .digest("hex")
    .slice(0, 16);
  const clauses = ["t.match_status <> 'excluded'", "s.enabled=1"];
  const values: Array<string | number> = [];
  if (input.kind) {
    clauses.push("t.kind=?");
    values.push(input.kind);
  }
  if (input.sourceId) {
    clauses.push("t.source_id=?");
    values.push(input.sourceId);
  }
  if (input.query?.trim()) {
    clauses.push(
      "(t.title LIKE ? ESCAPE '\\' OR t.original_title LIKE ? ESCAPE '\\')",
    );
    const q = `%${input.query.trim().replace(/[\\%_]/g, "\\$&")}%`;
    values.push(q, q);
  }
  if (input.genre) {
    clauses.push(
      "EXISTS(SELECT 1 FROM json_each(t.genres_json) WHERE value=?)",
    );
    values.push(input.genre);
  }
  if (input.year !== undefined) {
    clauses.push("t.year=?");
    values.push(input.year);
  }
  for (const key of ["favorite", "watchlist"] as const)
    if (input[key] !== undefined) {
      clauses.push(`COALESCE(p.${key},0)=?`);
      values.push(+input[key]);
    }
  if (input.watched !== undefined) {
    clauses.push(`${watchedExpression}=?`);
    values.push(+input.watched);
  }
  if (input.collectionId) {
    clauses.push(
      "EXISTS(SELECT 1 FROM media_collection_members WHERE title_id=t.id AND collection_id=?)",
    );
    values.push(input.collectionId);
  }
  if (cursor) {
    let c: unknown;
    try {
      c = JSON.parse(Buffer.from(cursor, "base64url").toString());
    } catch {
      throw new Error("Invalid cursor");
    }
    if (
      !Array.isArray(c) ||
      c.length !== 3 ||
      c[0] !== fingerprint ||
      (typeof c[1] !== "string" && typeof c[1] !== "number") ||
      typeof c[2] !== "string"
    )
      throw new Error("Invalid cursor");
    const comparison = descending ? "<" : ">";
    clauses.push(
      `(${order} ${comparison} ? OR (${order}=? AND t.id ${comparison} ?))`,
    );
    values.push(c[1], c[1], c[2]);
  }
  const rows = db
    .prepare(
      `SELECT t.id,${order} AS sort_value FROM media_titles t JOIN media_sources s ON s.id=t.source_id LEFT JOIN media_personal_state p ON p.title_id=t.id LEFT JOIN media_title_metadata m ON m.title_id=t.id WHERE ${clauses.join(" AND ")} ORDER BY ${order} ${descending ? "DESC" : "ASC"},t.id ${descending ? "DESC" : "ASC"} LIMIT ?`,
    )
    .all(...values, limit + 1) as Array<{
    id: string;
    sort_value: string | number;
  }>;
  const last = rows[Math.min(limit, rows.length) - 1];
  return {
    titles: rows.slice(0, limit).map((r) => getVideoSummary(db, r.id)!),
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify([fingerprint, last.sort_value, last.id]),
          ).toString("base64url")
        : null,
  };
}

export function createMediaCollection(
  db: CyberOsDatabase,
  name: string,
): MediaCollection {
  if (typeof name !== "string" || !name.trim() || name.length > 120)
    throw new Error("Invalid collection name");
  const id = randomUUID();
  db.prepare("INSERT INTO media_collections(id,name) VALUES(?,?)").run(
    id,
    name.trim(),
  );
  return { id, name: name.trim(), kind: "manual", titleIds: [] };
}
export function listMediaCollections(db: CyberOsDatabase): MediaCollection[] {
  return (
    db
      .prepare("SELECT id,name,kind FROM media_collections ORDER BY name,id")
      .all() as Omit<MediaCollection, "titleIds">[]
  ).map((c) => ({
    ...c,
    titleIds: (
      db
        .prepare(
          "SELECT title_id FROM media_collection_members WHERE collection_id=? ORDER BY position,title_id",
        )
        .all(c.id) as Array<{ title_id: string }>
    ).map((t) => t.title_id),
  }));
}
export function updateMediaCollection(
  db: CyberOsDatabase,
  id: string,
  patch: { name?: string; titleIds?: string[] },
): void {
  if (
    !patch ||
    typeof patch !== "object" ||
    Array.isArray(patch) ||
    Object.keys(patch).some((k) => !["name", "titleIds"].includes(k)) ||
    (patch.name !== undefined && typeof patch.name !== "string") ||
    (patch.titleIds !== undefined &&
      (!Array.isArray(patch.titleIds) ||
        patch.titleIds.some((t) => typeof t !== "string" || t.length > 256)))
  )
    throw new Error("Invalid collection");
  db.transaction(() => {
    const c = db
      .prepare("SELECT kind FROM media_collections WHERE id=?")
      .get(id) as { kind: string } | undefined;
    if (c?.kind !== "manual") throw new Error("Editable collection not found");
    if (patch.name !== undefined) {
      if (!patch.name.trim() || patch.name.length > 120)
        throw new Error("Invalid collection name");
      db.prepare("UPDATE media_collections SET name=? WHERE id=?").run(
        patch.name.trim(),
        id,
      );
    }
    if (patch.titleIds) {
      if (
        patch.titleIds.length > 10000 ||
        new Set(patch.titleIds).size !== patch.titleIds.length
      )
        throw new Error("Invalid collection members");
      db.prepare(
        "DELETE FROM media_collection_members WHERE collection_id=?",
      ).run(id);
      const insert = db.prepare(
        "INSERT INTO media_collection_members VALUES(?,?,?)",
      );
      patch.titleIds.forEach((t, i) => insert.run(id, t, i));
    }
  })();
}
export function deleteMediaCollection(db: CyberOsDatabase, id: string): void {
  db.prepare("DELETE FROM media_collections WHERE id=? AND kind='manual'").run(
    id,
  );
}

export function getVideoSummary(
  db: CyberOsDatabase,
  id: string,
): VideoTitle | null {
  const title = getMediaTitleSummary(db, id);
  if (!title) return null;
  const state = db
    .prepare(
      "SELECT favorite,watchlist,watched FROM media_personal_state WHERE title_id=?",
    )
    .get(id) as
    { favorite: number; watchlist: number; watched: number | null } | undefined;
  const meta = db
    .prepare(
      "SELECT rating,credits_json FROM media_title_metadata WHERE title_id=?",
    )
    .get(id) as { rating: number | null; credits_json: string } | undefined;
  return {
    ...title,
    watched: isWatched(db, id),
    personal: {
      favorite: !!state?.favorite,
      watchlist: !!state?.watchlist,
      watched: state?.watched == null ? null : !!state.watched,
    },
    rating: meta?.rating ?? null,
    credits: meta
      ? (JSON.parse(meta.credits_json) as VideoTitle["credits"])
      : [],
  };
}
export function getNextVideoFile(
  db: CyberOsDatabase,
  fileId: string,
): { fileId: string; title: string } | null {
  const row = db
    .prepare(
      "SELECT f.id AS fileId,t.title FROM media_files current JOIN media_episodes e ON e.id=current.episode_id JOIN media_seasons s ON s.id=e.season_id JOIN media_episodes next ON next.title_id=e.title_id JOIN media_seasons ns ON ns.id=next.season_id JOIN media_files f ON f.episode_id=next.id JOIN media_sources source ON source.id=f.source_id JOIN media_titles t ON t.id=f.title_id WHERE current.id=? AND source.enabled=1 AND t.match_status<>'excluded' AND ns.season_number>0 AND (ns.season_number>s.season_number OR (ns.season_number=s.season_number AND next.episode_number>e.episode_number)) ORDER BY ns.season_number,next.episode_number,f.relative_path LIMIT 1",
    )
    .get(fileId) as { fileId: string; title: string } | undefined;
  return row ?? null;
}
export function getVideoHome(db: CyberOsDatabase): VideoHome {
  const home = getMediaHome(db);
  const next = db
    .prepare(
      `WITH episodes AS (
    SELECT e.id,e.title_id,s.season_number,e.episode_number,
      ROW_NUMBER() OVER(PARTITION BY e.title_id ORDER BY s.season_number,e.episode_number) AS ordinal,
      COALESCE(state.watched,MAX(p.completed),0) AS watched,MAX(p.updated_at) AS updated
    FROM media_episodes e JOIN media_seasons s ON s.id=e.season_id
    LEFT JOIN media_files f ON f.episode_id=e.id LEFT JOIN media_progress p ON p.file_id=f.id AND p.profile_id='local-admin'
    LEFT JOIN media_episode_state state ON state.episode_id=e.id WHERE s.season_number>0 GROUP BY e.id
  ), last AS (SELECT title_id,MAX(CASE WHEN watched=1 THEN ordinal ELSE 0 END) AS ordinal,MAX(updated) AS updated FROM episodes GROUP BY title_id)
  SELECT e.title_id,e.id AS episode_id,e.season_number,e.episode_number,
    (SELECT id FROM media_files WHERE episode_id=e.id ORDER BY relative_path LIMIT 1) AS file_id
  FROM episodes e JOIN last ON last.title_id=e.title_id JOIN media_titles t ON t.id=e.title_id JOIN media_sources s ON s.id=t.source_id
  WHERE last.ordinal>0 AND e.ordinal=last.ordinal+1 AND s.enabled=1 AND t.match_status<>'excluded'
    AND EXISTS(SELECT 1 FROM media_files WHERE episode_id=e.id)
    AND NOT EXISTS(SELECT 1 FROM media_files f JOIN media_progress p ON p.file_id=f.id WHERE f.episode_id=e.id AND p.profile_id='local-admin' AND p.position_seconds>=120 AND p.completed=0)
  ORDER BY last.updated DESC,e.title_id LIMIT 20`,
    )
    .all() as Array<{
    title_id: string;
    file_id: string;
    episode_id: string;
    season_number: number;
    episode_number: number;
  }>;
  return {
    ...home,
    watchlist: listVideoTitles(db, { watchlist: true, limit: 20 }).titles,
    upNext: next.map((n) => ({
      title: getVideoSummary(db, n.title_id)!,
      fileId: n.file_id,
      episodeId: n.episode_id,
      seasonNumber: n.season_number,
      episodeNumber: n.episode_number,
    })),
    collections: listMediaCollections(db),
  };
}
