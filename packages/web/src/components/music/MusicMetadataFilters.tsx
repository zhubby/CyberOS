import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MusicFilterOptions } from "@cyberos/shared";
import { musicRequest } from "../../lib/music-api.js";
import { CustomSelect } from "../common/CustomSelect.js";

interface Props {
  sourceId: string;
  revision: string | undefined;
  year: string;
  genre: string;
  onYearChange: (year: string) => void;
  onGenreChange: (genre: string) => void;
}

export function MusicMetadataFilters({ sourceId, revision, year, genre, onYearChange, onGenreChange }: Props) {
  const { t } = useTranslation();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    scope: string;
    options: MusicFilterOptions | null;
  } | null>(null);
  const scope = JSON.stringify([sourceId, revision, attempt]);
  const loading = result?.scope !== scope;
  const options = loading ? null : result.options;

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (sourceId) params.set("sourceId", sourceId);
    void musicRequest<MusicFilterOptions>(`/filter-options?${params}`, "GET", undefined, controller.signal)
      .then((options) => {
        if (!controller.signal.aborted) setResult({ scope, options });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ scope, options: null });
      });
    return () => controller.abort();
  }, [scope, sourceId]);

  // Keep an existing draft visible when its value is absent from another source.
  const years = Array.from(new Set([...(options?.years.map(String) ?? []), ...(year ? [year] : [])]))
    .sort((a, b) => Number(b) - Number(a));
  const genres = Array.from(new Set([...(options?.genres ?? []), ...(genre ? [genre] : [])]));

  return (
    <>
      <div className="workspace-search-field-grid" aria-busy={loading}>
        <div className="workspace-search-field">
          <span>{t("music.year")}</span>
          <CustomSelect
            value={year}
            ariaLabel={t("music.year")}
            disabled={loading}
            options={[
              { value: "", label: t("music.allYears") },
              ...years.map((value) => ({ value, label: value })),
            ]}
            onChange={onYearChange}
          />
        </div>
        <div className="workspace-search-field">
          <span>{t("music.genre")}</span>
          <CustomSelect
            value={genre}
            ariaLabel={t("music.genre")}
            disabled={loading}
            options={[
              { value: "", label: t("music.allGenres") },
              ...genres.map((value) => ({ value, label: value })),
            ]}
            onChange={onGenreChange}
          />
        </div>
      </div>
      {loading ? (
        <div className="music-inline-state" role="status">{t("music.filterOptionsLoading")}</div>
      ) : options === null ? (
        <div className="music-inline-state music-filter-feedback" role="alert">
          <span>{t("music.filterOptionsFailed")}</span>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            {t("music.retryFilterOptions")}
          </button>
        </div>
      ) : null}
    </>
  );
}
