import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ClipboardCopy, GitBranch, GitCommitHorizontal, Package, Tag } from "lucide-react";
import type { BuildInfo } from "../../api.js";
import { formatDate } from "../../i18n/format.js";
import type { SupportedLocale } from "../../i18n/locale.js";

interface VersionSettingsPageProps {
  buildInfo: BuildInfo | null;
  error: string | null;
  loading: boolean;
  locale: SupportedLocale;
}

type CopyState = "idle" | "copied" | "failed";

export function VersionSettingsPage({ buildInfo, error, loading, locale }: VersionSettingsPageProps) {
  const { t } = useTranslation();
  const [copyState, setCopyState] = useState<CopyState>("idle");

  async function copyCommitSha() {
    if (!buildInfo?.commitSha) {
      setCopyState("failed");
      return;
    }
    if (await writeClipboardText(buildInfo.commitSha)) {
      setCopyState("copied");
    } else {
      setCopyState("failed");
    }
  }

  if (!buildInfo) {
    const status = loading ? t("common.states.loading") : t("common.states.unavailable");
    return (
      <div className="settings-content-body settings-version-page">
        <section className="settings-section-card settings-version-card">
          <header>
            <div className="settings-system-card-heading">
              <Package aria-hidden="true" size={17} />
              <div>
                <h3>{t("settings.version.buildIdentity")}</h3>
                <p>{t("settings.version.metadataUnavailable")}</p>
              </div>
            </div>
          </header>
          <p className="settings-inline-alert" role="status">{status}</p>
          {error ? <p className="settings-version-error">{error}</p> : null}
        </section>
      </div>
    );
  }

  const unknown = String(t("common.states.unknown"));
  const commitSha = buildInfo.commitSha ?? unknown;
  const copyLabel = copyState === "copied"
    ? String(t("settings.version.copied"))
    : copyState === "failed"
      ? String(t("settings.version.copyFailed"))
      : String(t("settings.version.copyCommit"));
  const sourceLabel = String(t(`settings.version.sources.${buildInfo.source}`));
  const dirtyLabel = buildInfo.dirty === null
    ? unknown
    : buildInfo.dirty
      ? String(t("settings.version.dirty.modified"))
      : String(t("settings.version.dirty.clean"));

  return (
    <div className="settings-content-body settings-version-page">
      <section className="settings-section-card settings-version-card">
        <header>
          <div className="settings-system-card-heading">
            <Package aria-hidden="true" size={17} />
            <div>
              <h3>{t("settings.version.buildIdentity")}</h3>
              <p>{t("settings.version.buildIdentityDescription")}</p>
            </div>
          </div>
        </header>

        <div className="settings-version-release">
          <span>{t("common.appName")}</span>
          <strong>{buildInfo.version === "unknown" ? unknown : `v${buildInfo.version}`}</strong>
          <small>{sourceLabel}</small>
        </div>

        <dl className="settings-version-details">
          <div>
            <dt><GitCommitHorizontal aria-hidden="true" size={15} />{t("settings.version.commit")}</dt>
            <dd className="is-mono" title={commitSha}>{commitSha}</dd>
            {buildInfo.commitSha ? (
              <button
                className="settings-version-copy"
                type="button"
                onClick={() => void copyCommitSha()}
                title={copyLabel}
                aria-label={copyLabel}
                data-state={copyState}
              >
                {copyState === "copied" ? <Check aria-hidden="true" size={15} /> : <ClipboardCopy aria-hidden="true" size={15} />}
              </button>
            ) : null}
          </div>
          <div>
            <dt><Tag aria-hidden="true" size={15} />{t("settings.version.tag")}</dt>
            <dd className="is-mono">{buildInfo.tag ?? unknown}</dd>
          </div>
          <div>
            <dt><GitBranch aria-hidden="true" size={15} />{t("settings.version.branch")}</dt>
            <dd className="is-mono">{buildInfo.branch ?? unknown}</dd>
          </div>
          <div>
            <dt>{t("settings.version.builtAt")}</dt>
            <dd>{buildInfo.builtAt ? formatDate(buildInfo.builtAt, locale) : unknown}</dd>
          </div>
          <div>
            <dt>{t("settings.version.workingTree")}</dt>
            <dd data-dirty={buildInfo.dirty === true ? "true" : undefined}>{dirtyLabel}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

async function writeClipboardText(value: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall back for browsers that expose Clipboard API without granting write permission.
    }
  }
  if (typeof document === "undefined") {
    return false;
  }

  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    input.remove();
  }
}
