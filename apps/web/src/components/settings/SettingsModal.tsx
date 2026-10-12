import { FormEvent, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Activity,
  Bot,
  Check,
  Clock3,
  Cpu,
  Database,
  Download,
  Folder,
  HardDrive,
  Image as ImageIcon,
  Images,
  KeyRound,
  Lock,
  MemoryStick,
  Network,
  Package,
  Search,
  Server,
  ShieldCheck,
  Wrench,
  X
} from "lucide-react";
import type {
  BuildInfo,
  DockerSettings,
  DownloadSettings,
  FileOperation,
  IndexerOverview,
  IndexerSettings,
  NasRoot,
  PendingApproval,
  ModelProviderSettings,
  PiToolPolicySettings,
  PhotostaffLibrarySettings,
  PhotostaffLibraryStatus,
  PhotostaffProcessingSettings,
  PhotostaffWorkerHealth,
  SystemInfo,
  SystemInfoStorageVolume
} from "../../api.js";
import { MAX_EDIT_TEXT_BYTES } from "../../api.js";
import {
  DANGEROUS_TOOL_POLICY_OPTIONS,
  READ_ONLY_TOOL_POLICY_OPTIONS,
  SETTINGS_SECTIONS,
  providerLabel,
  settingsGroupLabel,
  settingsSectionDescription,
  settingsSectionLabel,
  settingsSectionState,
  settingsSectionTitle,
  settingsStatus,
  settingsUpdatedAtLabel,
  type DockerSettingsFormState,
  type ModelProviderFormState,
  type SettingsSectionId,
  type SettingsState,
  type ToolPolicyFormState
} from "../../config/settings.js";
import { formatBytes, formatDate, formatLocaleNumber } from "../../i18n/format.js";
import type { LanguagePreference, SupportedLocale } from "../../i18n/locale.js";
import {
  CODE_FONT_OPTIONS,
  MAX_CODE_FONT_SIZE_PX,
  MIN_CODE_FONT_SIZE_PX,
  clampCodeFontSizePx,
  type CodeFontSettings
} from "../../lib/editor-settings.js";
import {
  previewFileSizeLimitBytesToMiB,
  previewFileSizeLimitMiBToBytes
} from "../../lib/preview-settings.js";
import type { ResolvedTheme, ThemePreference } from "../../lib/theme-settings.js";
import { CustomSelect } from "../common/CustomSelect.js";
import { VersionSettingsPage } from "./VersionSettingsPage.js";
import { SettingsIndexerPage } from "./SettingsIndexerPage.js";
import { SettingsOperationsPage } from "./SettingsOperationsPage.js";

interface SettingsModalProps {
  activeSection: SettingsSectionId;
  form: ModelProviderFormState;
  dockerForm: DockerSettingsFormState;
  loading: boolean;
  saving: boolean;
  dockerSettings: DockerSettings | null;
  downloadSettings: DownloadSettings | null;
  indexerSettings: IndexerSettings | null;
  indexerStatus: IndexerOverview | null;
  roots: NasRoot[];
  photostaffSettings: PhotostaffLibrarySettings | null;
  photostaffStatus: PhotostaffLibraryStatus | null;
  photostaffProcessingSettings: PhotostaffProcessingSettings | null;
  photostaffWorkerHealth: PhotostaffWorkerHealth | null;
  settings: ModelProviderSettings | null;
  systemInfo: SystemInfo | null;
  systemInfoError: string | null;
  buildInfo: BuildInfo | null;
  buildInfoError: string | null;
  pendingApprovals: PendingApproval[];
  operations: FileOperation[];
  operationsReady: boolean;
  toolPolicySettings: PiToolPolicySettings | null;
  toolPolicyForm: ToolPolicyFormState;
  languagePreference: LanguagePreference;
  themePreference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  previewFileSizeLimitBytes: number;
  codeFontSettings: CodeFontSettings;
  splitWidth: number;
  resolvedLocale: SupportedLocale;
  onClose: () => void;
  onFormChange: (form: ModelProviderFormState) => void;
  onDockerFormChange: (form: DockerSettingsFormState) => void;
  onDownloadSettingsChange: (
    patch: Partial<Omit<DownloadSettings, "updatedAt">>
  ) => Promise<void>;
  onIndexerSettingsChange: (
    patch: Partial<Omit<IndexerSettings, "updatedAt">>
  ) => Promise<void>;
  onIndexerReindex: (rootId: string) => Promise<void>;
  onPhotostaffProcessingSettingsChange: (
    patch: Partial<Omit<PhotostaffProcessingSettings, "updatedAt">>
  ) => Promise<void>;
  onToolPolicyFormChange: (form: ToolPolicyFormState) => void;
  onLanguagePreferenceChange: (preference: LanguagePreference) => void;
  onThemePreferenceChange: (preference: ThemePreference) => void;
  onPreviewFileSizeLimitChange: (bytes: number) => void;
  onCodeFontSettingsChange: (settings: CodeFontSettings) => void;
  onSectionChange: (section: SettingsSectionId) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

const PROVIDER_OPTIONS = ["openai", "anthropic"] as const;
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const DANGEROUS_TOOLS = ["bash", "edit", "write"] as const;
const DEFAULT_TEXT_PREVIEW_BYTES = 64 * 1024;
type Translate = (key: string, options?: Record<string, unknown>) => unknown;

export function SettingsModal({
  activeSection,
  form,
  dockerForm,
  loading,
  saving,
  dockerSettings,
  downloadSettings,
  indexerSettings,
  indexerStatus,
  roots,
  photostaffSettings,
  photostaffStatus,
  photostaffProcessingSettings,
  photostaffWorkerHealth,
  settings,
  systemInfo,
  systemInfoError,
  buildInfo,
  buildInfoError,
  pendingApprovals,
  operations,
  operationsReady,
  toolPolicySettings,
  toolPolicyForm,
  languagePreference,
  themePreference,
  resolvedTheme,
  previewFileSizeLimitBytes,
  codeFontSettings,
  splitWidth,
  resolvedLocale,
  onClose,
  onFormChange,
  onDockerFormChange,
  onDownloadSettingsChange,
  onIndexerSettingsChange,
  onIndexerReindex,
  onPhotostaffProcessingSettingsChange,
  onToolPolicyFormChange,
  onLanguagePreferenceChange,
  onThemePreferenceChange,
  onPreviewFileSizeLimitChange,
  onCodeFontSettingsChange,
  onSectionChange,
  onSubmit
}: SettingsModalProps) {
  const { t } = useTranslation();
  const [settingsSearch, setSettingsSearch] = useState("");
  const dialogRef = useRef<HTMLElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const currentSection = SETTINGS_SECTIONS.find((section) => section.id === activeSection) ?? SETTINGS_SECTIONS[0]!;
  const normalizedSearch = settingsSearch.trim().toLowerCase();
  const visibleSections = normalizedSearch
    ? SETTINGS_SECTIONS.filter((section) =>
        [
          settingsSectionTitle(section, t),
          settingsSectionDescription(section, t),
          settingsGroupLabel(section.group, t)
        ].some((value) => value.toLowerCase().includes(normalizedSearch))
      )
    : SETTINGS_SECTIONS;
  const groups = [...new Set(visibleSections.map((section) => section.group))];
  const currentState = settingsSectionState(
    currentSection,
    settings,
    dockerSettings,
    buildInfo,
    downloadSettings,
    photostaffStatus,
    indexerSettings
  );
  const providerOptions = PROVIDER_OPTIONS.map((provider) => ({
    value: provider,
    label: providerLabel(provider, t)
  }));

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus());

    return () => {
      window.cancelAnimationFrame(frame);
      const previousFocus = previousFocusRef.current;
      if (previousFocus?.isConnected) {
        window.requestAnimationFrame(() => previousFocus.focus());
      }
    };
  }, []);

  function handleDialogKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    ) ?? [])].filter((element) => element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="settings-modal settings-center"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <aside className="settings-rail" aria-label={t("settings.sectionsLabel")}>
          <div className="settings-rail-brand">
            <img className="settings-brand-logo" src="/sigmaos-icon.svg" alt={t("common.appName")} />
          </div>

          <label className="settings-search">
            <Search aria-hidden="true" size={15} />
            <input
              ref={searchInputRef}
              value={settingsSearch}
              onChange={(event) => setSettingsSearch(event.target.value)}
              placeholder={t("settings.searchPlaceholder")}
            />
          </label>

          <nav className="settings-nav">
            {groups.map((group) => (
              <section key={group}>
                <h3>{settingsGroupLabel(group, t)}</h3>
                {visibleSections.filter((section) => section.group === group).map((section) => (
                  <button
                    key={section.id}
                    type="button"
                    className={section.id === activeSection ? "is-active" : ""}
                    onClick={() => onSectionChange(section.id)}
                  >
                    {settingsSectionIcon(section.id)}
                    <span>
                      <strong>{settingsSectionTitle(section, t)}</strong>
                      <small>{settingsSectionLabel(section, settings, loading, t, dockerSettings, buildInfo, downloadSettings, photostaffSettings, photostaffStatus, indexerSettings)}</small>
                    </span>
                  </button>
                ))}
              </section>
            ))}
            {visibleSections.length === 0 ? (
              <p className="settings-empty-search">{t("settings.searchEmpty")}</p>
            ) : null}
          </nav>

          <div className="settings-rail-footer">
            <ShieldCheck aria-hidden="true" size={15} />
            <span>{t("settings.localProfile")}</span>
          </div>
        </aside>

        <section className="settings-content">
          <header className="settings-content-header">
            <div>
              <span className="eyebrow">{settingsGroupLabel(currentSection.group, t)}</span>
              <h2 id="settings-title">{settingsSectionTitle(currentSection, t)}</h2>
              <p>{settingsSectionDescription(currentSection, t)}</p>
              <div className="settings-header-meta" aria-label={t("settings.status")}>
                <span data-state={currentState}>
                  {settingsStateIcon(currentState)}
                  {settingsSectionLabel(currentSection, settings, loading, t, dockerSettings, buildInfo, downloadSettings, photostaffSettings, photostaffStatus, indexerSettings)}
                </span>
                {activeSection === "version" ? (
                  <span>
                    <ShieldCheck aria-hidden="true" size={13} />
                    {t("settings.version.readOnly")}
                  </span>
                ) : (
                  <span>
                    <Lock aria-hidden="true" size={13} />
                    {t("settings.secretsMasked")}
                  </span>
                )}
              </div>
            </div>
            <button type="button" onClick={onClose} title={t("common.actions.closeSettings")}>
              <X aria-hidden="true" size={18} />
            </button>
          </header>

          {activeSection === "overview" ? (
            <SettingsOverview
              loading={loading}
              settings={settings}
              dockerSettings={dockerSettings}
              systemInfo={systemInfo}
              systemInfoError={systemInfoError}
              buildInfo={buildInfo}
              downloadSettings={downloadSettings}
              photostaffSettings={photostaffSettings}
              photostaffStatus={photostaffStatus}
              locale={resolvedLocale}
              onSectionChange={onSectionChange}
            />
          ) : null}

          {activeSection === "model-providers" ? (
            <form className="settings-form" onSubmit={onSubmit}>
              <div className="settings-content-body">
                <div className="settings-page-grid settings-provider-grid">
                  <div className="settings-main-stack">
                    <section className="settings-section-card">
                      <header>
                        <div>
                          <h3>{t("settings.modelProvider.profileTitle")}</h3>
                          <p>{t("settings.modelProvider.profileDescription")}</p>
                        </div>
                        <span data-state={settings?.apiKeyConfigured ? "ready" : "missing"}>
                          {settings?.apiKeyConfigured ? t("common.states.configured") : t("common.states.needsKey")}
                        </span>
                      </header>

                      <fieldset className="settings-field-grid" disabled={loading || saving}>
                        <div className="settings-preference-field">
                          <span>{t("settings.modelProvider.provider")}</span>
                          <CustomSelect
                            id="model-provider"
                            value={form.providerName}
                            options={providerOptions}
                            onChange={(providerName) =>
                              onFormChange({
                                ...form,
                                providerName
                              })
                            }
                            ariaLabel={t("settings.modelProvider.provider")}
                          />
                        </div>

                        <label className="settings-field-wide">
                          <span>{t("settings.modelProvider.baseUrl")}</span>
                          <input
                            value={form.baseUrl}
                            onChange={(event) =>
                              onFormChange({
                                ...form,
                                baseUrl: event.target.value
                              })
                            }
                            placeholder="https://api.example.com/v1"
                          />
                        </label>

                        <label className="settings-field-wide">
                          <span>{t("settings.modelProvider.model")}</span>
                          <input
                            value={form.model}
                            onChange={(event) =>
                              onFormChange({
                                ...form,
                                model: event.target.value
                              })
                            }
                            placeholder="provider/model-name"
                          />
                        </label>
                      </fieldset>
                    </section>

                    <section className="settings-section-card">
                      <header>
                        <div>
                          <h3>{t("settings.modelProvider.credentialsTitle")}</h3>
                          <p>{t("settings.modelProvider.credentialsDescription")}</p>
                        </div>
                        <span data-state={settings?.apiKeyConfigured ? "ready" : "missing"}>
                          {settingsStatus(settings, t)}
                        </span>
                      </header>

                      <fieldset className="settings-field-grid settings-field-grid-single" disabled={loading || saving}>
                        <label className="settings-field-wide">
                          <span>{t("settings.modelProvider.apiKey")}</span>
                          <input
                            type="password"
                            value={form.apiKey}
                            onChange={(event) =>
                              onFormChange({
                                ...form,
                                apiKey: event.target.value,
                                clearApiKey: false
                              })
                            }
                            placeholder={
                              settings?.apiKeyConfigured
                                ? t("settings.modelProvider.configuredPlaceholder")
                                : t("settings.modelProvider.notConfiguredPlaceholder")
                            }
                          />
                        </label>

                        <label className="settings-check settings-field-wide">
                          <input
                            type="checkbox"
                            checked={form.clearApiKey}
                            onChange={(event) =>
                              onFormChange({
                                ...form,
                                apiKey: event.target.checked ? "" : form.apiKey,
                                clearApiKey: event.target.checked
                              })
                            }
                          />
                          <span>{t("settings.modelProvider.clearApiKey")}</span>
                        </label>
                      </fieldset>

                      <div className="settings-secret-note">
                        <Lock aria-hidden="true" size={15} />
                        <span>{t("settings.modelProvider.apiKeyNote")}</span>
                      </div>
                    </section>
                  </div>

                  <aside className="settings-side-stack" aria-label={t("settings.providerSummary")}>
                    <section className="settings-section-card settings-route-card">
                      <header>
                        <div>
                          <h3>{t("settings.modelProvider.activeRoute")}</h3>
                          <p>{t("settings.modelProvider.activeRouteDescription")}</p>
                        </div>
                      </header>
                      <dl className="settings-summary-list">
                        <div>
                          <dt>{t("settings.modelProvider.provider")}</dt>
                          <dd>{providerLabel(form.providerName, t)}</dd>
                        </div>
                        <div>
                          <dt>{t("settings.modelProvider.endpoint")}</dt>
                          <dd>{form.baseUrl || t("settings.modelProvider.defaultEndpoint")}</dd>
                        </div>
                        <div>
                          <dt>{t("settings.modelProvider.model")}</dt>
                          <dd>{form.model || t("settings.modelProvider.notSet")}</dd>
                        </div>
                        <div>
                          <dt>{t("settings.modelProvider.updated")}</dt>
                          <dd>{settingsUpdatedAtLabel(settings, resolvedLocale, t)}</dd>
                        </div>
                      </dl>
                    </section>
                  </aside>
                </div>
              </div>

              <footer className="settings-actions">
                <span>{loading ? t("settings.modelProvider.loadingSettings") : settingsStatus(settings, t)}</span>
                <div>
                  <button className="secondary-button" type="button" onClick={onClose}>
                    {t("common.actions.cancel")}
                  </button>
                  <button className="primary-button" type="submit" disabled={loading || saving} aria-busy={loading || saving || undefined}>
                    {saving ? t("common.actions.saving") : t("common.actions.saveChanges")}
                  </button>
                </div>
              </footer>
            </form>
          ) : null}

          {activeSection === "version" ? (
            <VersionSettingsPage
              buildInfo={buildInfo}
              error={buildInfoError}
              loading={loading}
              locale={resolvedLocale}
            />
          ) : null}

          {activeSection === "appearance" ? (
            <SettingsAppearancePage
              languagePreference={languagePreference}
              themePreference={themePreference}
              resolvedTheme={resolvedTheme}
              resolvedLocale={resolvedLocale}
              splitWidth={splitWidth}
              onLanguagePreferenceChange={onLanguagePreferenceChange}
              onThemePreferenceChange={onThemePreferenceChange}
            />
          ) : null}

          {activeSection === "agents" ? (
            <SettingsToolPolicyPage
              form={toolPolicyForm}
              settings={toolPolicySettings}
              loading={loading}
              saving={saving}
              locale={resolvedLocale}
              onChange={onToolPolicyFormChange}
              onSubmit={onSubmit}
              onClose={onClose}
            />
          ) : null}

          {activeSection === "docker" ? (
            <SettingsDockerPage
              form={dockerForm}
              settings={dockerSettings}
              loading={loading}
              saving={saving}
              locale={resolvedLocale}
              onChange={onDockerFormChange}
              onSubmit={onSubmit}
              onClose={onClose}
            />
          ) : null}

          {activeSection === "files" ? (
            <SettingsFilesPage
              previewFileSizeLimitBytes={previewFileSizeLimitBytes}
              codeFontSettings={codeFontSettings}
              locale={resolvedLocale}
              onPreviewFileSizeLimitChange={onPreviewFileSizeLimitChange}
              onCodeFontSettingsChange={onCodeFontSettingsChange}
            />
          ) : null}

          {activeSection === "downloads" ? (
            <SettingsDownloadsPage
              settings={downloadSettings}
              loading={loading}
              locale={resolvedLocale}
              onSettingsChange={onDownloadSettingsChange}
              onClose={onClose}
            />
          ) : null}

          {activeSection === "indexer" ? (
            <SettingsIndexerPage
              settings={indexerSettings}
              status={indexerStatus}
              roots={roots}
              loading={loading}
              locale={resolvedLocale}
              onSettingsChange={onIndexerSettingsChange}
              onReindex={onIndexerReindex}
              onClose={onClose}
            />
          ) : null}

          {activeSection === "operations" ? (
            <SettingsOperationsPage locale={resolvedLocale} onClose={onClose} />
          ) : null}

          {activeSection === "photostaff" ? (
            <SettingsPhotostaffPage
              settings={photostaffSettings}
              status={photostaffStatus}
              processingSettings={photostaffProcessingSettings}
              workerHealth={photostaffWorkerHealth}
              runtime={systemInfo?.sigma.photostaff ?? null}
              loading={loading}
              locale={resolvedLocale}
              onSettingsChange={onPhotostaffProcessingSettingsChange}
              onClose={onClose}
            />
          ) : null}

          {activeSection === "security" ? (
            <SettingsSecurityPage
              settings={settings}
              systemInfo={systemInfo}
              loading={loading}
              toolPolicyForm={toolPolicyForm}
              pendingApprovals={pendingApprovals}
              operations={operations}
              operationsReady={operationsReady}
              locale={resolvedLocale}
            />
          ) : null}

          {activeSection === "advanced" ? (
            <SettingsAdvancedPage
              systemInfo={systemInfo}
              loading={loading}
              locale={resolvedLocale}
            />
          ) : null}
        </section>
      </section>
    </div>
  );
}

function SettingsOverview({
  loading,
  settings,
  dockerSettings,
  systemInfo,
  systemInfoError,
  buildInfo,
  downloadSettings,
  photostaffSettings,
  photostaffStatus,
  locale,
  onSectionChange
}: {
  loading: boolean;
  settings: ModelProviderSettings | null;
  dockerSettings: DockerSettings | null;
  systemInfo: SystemInfo | null;
  systemInfoError: string | null;
  buildInfo: BuildInfo | null;
  downloadSettings: DownloadSettings | null;
  photostaffSettings: PhotostaffLibrarySettings | null;
  photostaffStatus: PhotostaffLibraryStatus | null;
  locale: SupportedLocale;
  onSectionChange: (section: SettingsSectionId) => void;
}) {
  const { t } = useTranslation();
  const systemStatus = systemInfo
    ? t("settings.system.collectedAt", { time: formatDate(systemInfo.collectedAt, locale) })
    : loading
      ? t("common.states.loading")
      : t("common.states.unavailable");
  const metricItems = systemInfo
    ? [
        {
          value: formatLocaleNumber(systemInfo.hardware.cpuThreads, locale),
          label: t("settings.system.metrics.logicalCpus")
        },
        {
          value: formatBytes(systemInfo.hardware.memory.totalBytes, locale),
          label: t("settings.system.metrics.memory")
        },
        {
          value: formatDuration(systemInfo.operatingSystem.uptimeSeconds, locale, t),
          label: t("settings.system.metrics.uptime")
        },
        {
          value: formatLocaleNumber(systemInfo.sigma.nasRoots.length, locale),
          label: t("settings.system.metrics.nasRoots")
        }
      ]
    : [
        {
          value: formatLocaleNumber(SETTINGS_SECTIONS.length, locale),
          label: t("settings.overview.sections")
        },
        {
          value: formatLocaleNumber(
            SETTINGS_SECTIONS.filter((section) => settingsSectionState(section, settings, dockerSettings, buildInfo, downloadSettings, photostaffStatus) === "ready")
              .length,
            locale
          ),
          label: t("settings.overview.configured")
        },
        {
          value: formatLocaleNumber(
            SETTINGS_SECTIONS.filter((section) => settingsSectionState(section, settings, dockerSettings, buildInfo, downloadSettings, photostaffStatus) === "missing")
              .length,
            locale
          ),
          label: t("settings.overview.needsAttention")
        }
      ];

  return (
    <div className="settings-content-body settings-overview">
      <div className="settings-overview-grid">
        <section className="settings-section-card settings-identity-card">
          <header>
            <div>
              <h3>{t("settings.overview.systemProfile")}</h3>
              <p>{t("settings.overview.systemProfileDescription")}</p>
            </div>
            <span data-state={systemInfo ? "ready" : systemInfoError ? "missing" : "loading"}>{systemStatus}</span>
          </header>
          <div className="settings-metric-grid settings-system-metric-grid">
            {metricItems.map((item) => (
              <article key={item.label}>
                <strong>{item.value}</strong>
                <span>{item.label}</span>
              </article>
            ))}
          </div>
        </section>

        <section className="settings-section-card">
          <header>
            <div>
              <h3>{t("settings.overview.modelProvider")}</h3>
              <p>{t("settings.overview.modelProviderDescription")}</p>
            </div>
            <span data-state={settings?.apiKeyConfigured ? "ready" : "missing"}>
              {loading ? t("common.states.loading") : settingsStatus(settings, t)}
            </span>
          </header>
          <dl className="settings-summary-list">
            <div>
              <dt>{t("settings.modelProvider.provider")}</dt>
              <dd>{settings ? providerLabel(settings.providerName, t) : t("settings.modelProvider.notLoaded")}</dd>
            </div>
            <div>
              <dt>{t("settings.modelProvider.endpoint")}</dt>
              <dd>{settings?.baseUrl || t("settings.modelProvider.defaultEndpoint")}</dd>
            </div>
            <div>
              <dt>{t("settings.modelProvider.model")}</dt>
              <dd>{settings?.model || t("settings.modelProvider.notSet")}</dd>
            </div>
            <div>
              <dt>{t("settings.modelProvider.updated")}</dt>
              <dd>{settingsUpdatedAtLabel(settings, locale, t)}</dd>
            </div>
          </dl>
        </section>
      </div>

      {systemInfo ? <SettingsSystemDetails systemInfo={systemInfo} locale={locale} /> : null}

      <section className="settings-section-card">
        <header>
          <div>
            <h3>{t("settings.overview.settingsMap")}</h3>
            <p>{t("settings.overview.settingsMapDescription")}</p>
          </div>
        </header>
        <div className="settings-area-list">
          {SETTINGS_SECTIONS.filter((section) => section.id !== "overview").map((section) => (
            <button key={section.id} type="button" onClick={() => onSectionChange(section.id)}>
              {settingsSectionIcon(section.id)}
              <span>
                <strong>{settingsSectionTitle(section, t)}</strong>
                <small>{settingsSectionDescription(section, t)}</small>
              </span>
              <em data-state={settingsSectionState(section, settings, dockerSettings, buildInfo, downloadSettings, photostaffStatus)}>
                {settingsSectionLabel(section, settings, loading, t, dockerSettings, buildInfo, downloadSettings, photostaffSettings, photostaffStatus)}
              </em>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

interface SettingsInfoRow {
  label: string;
  value: string;
  detail?: string;
  mono?: boolean;
}

interface SettingsConfigRowItem {
  label: string;
  detail: string;
  value: string;
  state?: SettingsState;
}

function SettingsSystemDetails({
  systemInfo,
  locale
}: {
  systemInfo: SystemInfo;
  locale: SupportedLocale;
}) {
  const { t } = useTranslation();
  const memory = systemInfo.hardware.memory;
  const runtimeMemory = systemInfo.runtime.memory;
  const osRows: SettingsInfoRow[] = [
    {
      label: t("settings.system.labels.hostname"),
      value: systemInfo.identity.hostname
    },
    {
      label: t("settings.system.labels.admin"),
      value: systemInfo.identity.adminDisplayName
    },
    {
      label: t("settings.system.labels.timezone"),
      value: systemInfo.identity.timezone
    },
    {
      label: t("settings.system.labels.os"),
      value: `${systemInfo.operatingSystem.type} ${systemInfo.operatingSystem.release}`,
      detail: systemInfo.operatingSystem.version
    },
    {
      label: t("settings.system.labels.platform"),
      value: `${systemInfo.operatingSystem.platform} / ${systemInfo.operatingSystem.arch}`
    },
    {
      label: t("settings.system.labels.machine"),
      value: systemInfo.operatingSystem.machine
    },
    {
      label: t("settings.system.labels.endianness"),
      value: systemInfo.operatingSystem.endianness
    },
    {
      label: t("settings.system.labels.systemUptime"),
      value: formatDuration(systemInfo.operatingSystem.uptimeSeconds, locale, t)
    },
    {
      label: t("settings.system.labels.loadAverage"),
      value: formatLoadAverage(systemInfo.operatingSystem.loadAverage, locale)
    }
  ];
  const hardwareRows: SettingsInfoRow[] = [
    {
      label: t("settings.system.labels.cpuModel"),
      value: systemInfo.hardware.cpuModel ?? t("common.dash")
    },
    {
      label: t("settings.system.labels.cpuThreads"),
      value: formatLocaleNumber(systemInfo.hardware.cpuThreads, locale)
    },
    {
      label: t("settings.system.labels.availableParallelism"),
      value: formatLocaleNumber(systemInfo.operatingSystem.availableParallelism, locale)
    },
    {
      label: t("settings.system.labels.cpuSpeed"),
      value: systemInfo.hardware.cpuSpeedMHz
        ? t("settings.system.values.megahertz", {
            value: formatLocaleNumber(systemInfo.hardware.cpuSpeedMHz, locale)
          })
        : t("common.dash")
    },
    {
      label: t("settings.system.labels.totalMemory"),
      value: formatBytes(memory.totalBytes, locale)
    },
    {
      label: t("settings.system.labels.usedMemory"),
      value: `${formatBytes(memory.usedBytes, locale)} (${formatPercent(memory.usedPercent, locale)})`
    },
    {
      label: t("settings.system.labels.freeMemory"),
      value: formatBytes(memory.freeBytes, locale)
    }
  ];
  const runtimeRows: SettingsInfoRow[] = [
    {
      label: t("settings.system.labels.nodeVersion"),
      value: systemInfo.runtime.nodeVersion
    },
    {
      label: t("settings.system.labels.processUptime"),
      value: formatDuration(systemInfo.runtime.uptimeSeconds, locale, t)
    },
    {
      label: t("settings.system.labels.pid"),
      value: formatLocaleNumber(systemInfo.runtime.pid, locale)
    },
    {
      label: t("settings.system.labels.cwd"),
      value: systemInfo.runtime.cwd,
      mono: true
    },
    {
      label: t("settings.system.labels.execPath"),
      value: systemInfo.runtime.execPath,
      mono: true
    },
    {
      label: t("settings.system.labels.rss"),
      value: formatBytes(runtimeMemory.rssBytes, locale)
    },
    {
      label: t("settings.system.labels.heapUsed"),
      value: `${formatBytes(runtimeMemory.heapUsedBytes, locale)} / ${formatBytes(runtimeMemory.heapTotalBytes, locale)}`
    },
    {
      label: t("settings.system.labels.externalMemory"),
      value: formatBytes(runtimeMemory.externalBytes, locale)
    },
    {
      label: t("settings.system.labels.arrayBuffers"),
      value: formatBytes(runtimeMemory.arrayBuffersBytes, locale)
    }
  ];
  const sigmaRows: SettingsInfoRow[] = [
    {
      label: t("settings.system.labels.dataDir"),
      value: systemInfo.sigma.dataDir,
      mono: true
    },
    {
      label: t("settings.system.labels.databasePath"),
      value: systemInfo.sigma.databasePath,
      mono: true
    },
    {
      label: t("settings.system.labels.apiBind"),
      value: `${systemInfo.sigma.apiHost}:${systemInfo.sigma.apiPort}`
    },
    {
      label: t("settings.system.labels.allowedOrigins"),
      value: formatLocaleNumber(systemInfo.sigma.allowedOriginCount, locale)
    },
    {
      label: t("settings.system.labels.workerPoll"),
      value: t("settings.system.values.milliseconds", {
        value: formatLocaleNumber(systemInfo.sigma.workerPollMs, locale)
      })
    },
    {
      label: t("settings.system.labels.authMode"),
      value: systemInfo.identity.authMode
    },
    {
      label: t("settings.system.labels.modelMode"),
      value: systemInfo.sigma.modelProvider
    },
    {
      label: t("settings.system.labels.localEndpoint"),
      value: systemInfo.sigma.localEndpointConfigured ? t("settings.system.values.configured") : t("settings.system.values.notConfigured")
    }
  ];

  return (
    <div className="settings-system-grid">
      <SettingsInfoCard
        icon={<Server aria-hidden="true" size={17} />}
        title={t("settings.system.cards.operatingSystem")}
        description={t("settings.system.cards.operatingSystemDescription")}
        rows={osRows}
      />

      <SettingsInfoCard
        icon={<Cpu aria-hidden="true" size={17} />}
        title={t("settings.system.cards.hardware")}
        description={t("settings.system.cards.hardwareDescription")}
        rows={hardwareRows}
      >
        <SettingsUsageBar
          label={t("settings.system.labels.memoryPressure")}
          value={memory.usedPercent}
          locale={locale}
        />
      </SettingsInfoCard>

      <section className="settings-section-card settings-system-wide">
        <header>
          <div className="settings-system-card-heading">
            <Cpu aria-hidden="true" size={17} />
            <div>
              <h3>{t("settings.system.cards.cpuDetails")}</h3>
              <p>{t("settings.system.cards.cpuDetailsDescription")}</p>
            </div>
          </div>
        </header>
        <div className="settings-system-table-wrap">
          <table className="settings-system-table">
            <thead>
              <tr>
                <th>{t("settings.system.table.thread")}</th>
                <th>{t("settings.system.table.model")}</th>
                <th>{t("settings.system.table.speed")}</th>
                <th>{t("settings.system.table.user")}</th>
                <th>{t("settings.system.table.system")}</th>
                <th>{t("settings.system.table.idle")}</th>
              </tr>
            </thead>
            <tbody>
              {systemInfo.hardware.cpus.map((cpu, index) => (
                <tr key={`${cpu.model}-${index}`}>
                  <td>{formatLocaleNumber(index + 1, locale)}</td>
                  <td title={cpu.model}>{cpu.model}</td>
                  <td>
                    {t("settings.system.values.megahertz", {
                      value: formatLocaleNumber(cpu.speedMHz, locale)
                    })}
                  </td>
                  <td>{formatDuration(Math.round(cpu.times.userMs / 1000), locale, t)}</td>
                  <td>{formatDuration(Math.round(cpu.times.systemMs / 1000), locale, t)}</td>
                  <td>{formatDuration(Math.round(cpu.times.idleMs / 1000), locale, t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="settings-section-card settings-system-wide">
        <header>
          <div className="settings-system-card-heading">
            <Database aria-hidden="true" size={17} />
            <div>
              <h3>{t("settings.system.cards.storage")}</h3>
              <p>{t("settings.system.cards.storageDescription")}</p>
            </div>
          </div>
        </header>
        <div className="settings-storage-list">
          {systemInfo.storage.volumes.map((volume) => (
            <SettingsStorageRow key={volume.id} volume={volume} locale={locale} />
          ))}
        </div>
      </section>

      <section className="settings-section-card settings-system-wide">
        <header>
          <div className="settings-system-card-heading">
            <Network aria-hidden="true" size={17} />
            <div>
              <h3>{t("settings.system.cards.network")}</h3>
              <p>{t("settings.system.cards.networkDescription")}</p>
            </div>
          </div>
          <span data-state="ready">
            {formatLocaleNumber(systemInfo.network.interfaces.length, locale)}
          </span>
        </header>
        <div className="settings-system-table-wrap">
          <table className="settings-system-table settings-network-table">
            <thead>
              <tr>
                <th>{t("settings.system.table.interface")}</th>
                <th>{t("settings.system.table.family")}</th>
                <th>{t("settings.system.table.address")}</th>
                <th>{t("settings.system.table.cidr")}</th>
                <th>{t("settings.system.table.mac")}</th>
                <th>{t("settings.system.table.scope")}</th>
                <th>{t("settings.system.table.type")}</th>
              </tr>
            </thead>
            <tbody>
              {systemInfo.network.interfaces.map((networkInterface, index) => (
                <tr key={`${networkInterface.name}-${networkInterface.address}-${index}`}>
                  <td>{networkInterface.name}</td>
                  <td>{networkInterface.family}</td>
                  <td className="is-mono">{networkInterface.address}</td>
                  <td className="is-mono">{networkInterface.cidr ?? t("common.dash")}</td>
                  <td className="is-mono">{networkInterface.mac}</td>
                  <td>{networkInterface.scopeId ?? t("common.dash")}</td>
                  <td>
                    {networkInterface.internal
                      ? t("settings.system.values.internal")
                      : t("settings.system.values.external")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <SettingsInfoCard
        icon={<MemoryStick aria-hidden="true" size={17} />}
        title={t("settings.system.cards.runtime")}
        description={t("settings.system.cards.runtimeDescription")}
        rows={runtimeRows}
      >
        <div className="settings-system-chip-grid" aria-label={t("settings.system.labels.runtimeVersions")}>
          {Object.entries(systemInfo.runtime.versions).map(([name, value]) => (
            <span key={name}>
              <strong>{name}</strong>
              <em>{value}</em>
            </span>
          ))}
        </div>
      </SettingsInfoCard>

      <SettingsInfoCard
        icon={<HardDrive aria-hidden="true" size={17} />}
        title={t("settings.system.cards.sigma")}
        description={t("settings.system.cards.sigmaDescription")}
        rows={sigmaRows}
      >
        <div className="settings-root-list" aria-label={t("settings.system.labels.nasRoots")}>
          {systemInfo.sigma.nasRoots.map((root) => (
            <div key={root.id}>
              <strong>{root.name}</strong>
              <span>{root.id}</span>
              <small title={root.path}>{root.path}</small>
            </div>
          ))}
        </div>
      </SettingsInfoCard>
    </div>
  );
}

function SettingsInfoCard({
  icon,
  title,
  description,
  rows,
  children
}: {
  icon: ReactNode;
  title: string;
  description: string;
  rows: SettingsInfoRow[];
  children?: ReactNode;
}) {
  return (
    <section className="settings-section-card settings-system-card">
      <header>
        <div className="settings-system-card-heading">
          {icon}
          <div>
            <h3>{title}</h3>
            <p>{description}</p>
          </div>
        </div>
      </header>
      <SettingsInfoList rows={rows} />
      {children}
    </section>
  );
}

function SettingsInfoList({ rows }: { rows: SettingsInfoRow[] }) {
  return (
    <dl className="settings-summary-list settings-system-list">
      {rows.map((row, index) => (
        <div key={`${row.label}-${index}`}>
          <dt>{row.label}</dt>
          <dd className={row.mono ? "is-mono" : undefined} title={row.value}>
            {row.value}
            {row.detail ? <small>{row.detail}</small> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function SettingsUsageBar({
  label,
  value,
  locale
}: {
  label: string;
  value: number;
  locale: SupportedLocale;
}) {
  const percent = clampPercent(value) * 100;

  return (
    <div className="settings-usage-bar">
      <span>
        <strong>{label}</strong>
        <em>{formatPercent(value, locale)}</em>
      </span>
      <div>
        <i style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function SettingsStorageRow({
  volume,
  locale
}: {
  volume: SystemInfoStorageVolume;
  locale: SupportedLocale;
}) {
  const { t } = useTranslation();

  return (
    <div className="settings-storage-row">
      <div>
        <strong>{storageVolumeLabel(volume, t)}</strong>
        <small title={volume.path}>{volume.path}</small>
      </div>
      {volume.status === "ready" && volume.usedPercent !== null ? (
        <SettingsUsageBar
          label={t("settings.system.labels.storageUsed")}
          value={volume.usedPercent}
          locale={locale}
        />
      ) : (
        <em data-state="missing">{t("common.states.unavailable")}</em>
      )}
      <dl>
        <div>
          <dt>{t("settings.system.labels.total")}</dt>
          <dd>{formatNullableBytes(volume.totalBytes, locale, t)}</dd>
        </div>
        <div>
          <dt>{t("settings.system.labels.available")}</dt>
          <dd>{formatNullableBytes(volume.availableBytes, locale, t)}</dd>
        </div>
        <div>
          <dt>{t("settings.system.labels.free")}</dt>
          <dd>{formatNullableBytes(volume.freeBytes, locale, t)}</dd>
        </div>
        <div>
          <dt>{t("settings.system.labels.blockSize")}</dt>
          <dd>{formatNullableBytes(volume.blockSizeBytes, locale, t)}</dd>
        </div>
        <div>
          <dt>{t("settings.system.labels.rootId")}</dt>
          <dd>{volume.rootId ?? t("common.dash")}</dd>
        </div>
      </dl>
    </div>
  );
}

function SettingsAppearancePage({
  languagePreference,
  themePreference,
  resolvedTheme,
  resolvedLocale,
  splitWidth,
  onLanguagePreferenceChange,
  onThemePreferenceChange
}: {
  languagePreference: LanguagePreference;
  themePreference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  resolvedLocale: SupportedLocale;
  splitWidth: number;
  onLanguagePreferenceChange: (preference: LanguagePreference) => void;
  onThemePreferenceChange: (preference: ThemePreference) => void;
}) {
  const { t } = useTranslation();
  const themeOptions: { value: ThemePreference; label: string }[] = [
    { value: "system", label: t("settings.appearance.systemTheme") },
    { value: "light", label: t("settings.appearance.lightTheme") },
    { value: "dark", label: t("settings.appearance.darkTheme") }
  ];
  const languageOptions: { value: LanguagePreference; label: string }[] = [
    { value: "system", label: t("common.language.system") },
    { value: "en", label: t("common.language.english") },
    { value: "zh-CN", label: t("common.language.chineseSimplified") }
  ];
  const selectedThemeLabel =
    themeOptions.find((option) => option.value === themePreference)?.label ?? themePreference;
  const selectedLanguageLabel =
    languageOptions.find((option) => option.value === languagePreference)?.label ?? languagePreference;
  const activeThemeLabel = themeResolvedLabel(resolvedTheme, t);
  const interfaceRows: SettingsConfigRowItem[] = [
    {
      label: t("settings.appearance.density"),
      detail: t("settings.appearance.densityDetail"),
      value: t("settings.appearance.compactDensity")
    },
    {
      label: t("settings.appearance.splitWidth"),
      detail: t("settings.appearance.splitWidthDetail"),
      value: t("settings.appearance.pixelValue", {
        value: formatLocaleNumber(splitWidth, resolvedLocale)
      })
    },
    {
      label: t("settings.appearance.mobileTabs"),
      detail: t("settings.appearance.mobileTabsDetail"),
      value: t("settings.appearance.enabled")
    }
  ];

  return (
    <div className="settings-content-body">
      <div className="settings-page-grid">
        <section className="settings-section-card">
          <header>
            <div>
              <h3>{t("settings.appearance.themeTitle")}</h3>
              <p>{t("settings.appearance.themeDescription")}</p>
            </div>
            <span data-state="ready">
              {t("settings.appearance.activeTheme", {
                theme: activeThemeLabel
              })}
            </span>
          </header>
          <div className="settings-preference-field">
            <span>{t("settings.appearance.themeField")}</span>
            <CustomSelect
              id="theme-select"
              value={themePreference}
              options={themeOptions}
              ariaLabel={`${t("settings.appearance.themeField")}: ${selectedThemeLabel}`}
              onChange={onThemePreferenceChange}
            />
            <small>{t("settings.appearance.themeHelp")}</small>
          </div>
        </section>

        <section className="settings-section-card">
          <header>
            <div>
              <h3>{t("settings.appearance.languageTitle")}</h3>
              <p>{t("settings.appearance.languageDescription")}</p>
            </div>
            <span data-state="ready">{languageLocaleLabel(resolvedLocale, t)}</span>
          </header>
          <div className="settings-preference-field">
            <span>{t("settings.appearance.languageField")}</span>
            <CustomSelect
              id="language-select"
              value={languagePreference}
              options={languageOptions}
              ariaLabel={`${t("settings.appearance.languageField")}: ${selectedLanguageLabel}`}
              onChange={onLanguagePreferenceChange}
            />
            <small>{t("settings.appearance.languageHelp")}</small>
          </div>
        </section>

        <section className="settings-section-card">
          <header>
            <div>
              <h3>{t("settings.appearance.interfaceTitle")}</h3>
              <p>{t("settings.appearance.interfaceDescription")}</p>
            </div>
            <span data-state="ready">{t("common.states.configured")}</span>
          </header>
          <SettingsConfigRows items={interfaceRows} />
        </section>
      </div>
    </div>
  );
}

function SettingsFilesPage({
  previewFileSizeLimitBytes,
  codeFontSettings,
  locale,
  onPreviewFileSizeLimitChange,
  onCodeFontSettingsChange
}: {
  previewFileSizeLimitBytes: number;
  codeFontSettings: CodeFontSettings;
  locale: SupportedLocale;
  onPreviewFileSizeLimitChange: (bytes: number) => void;
  onCodeFontSettingsChange: (settings: CodeFontSettings) => void;
}) {
  const { t } = useTranslation();
  const previewFileSizeLimitMiB = previewFileSizeLimitBytesToMiB(previewFileSizeLimitBytes);
  const [draftLimitMiB, setDraftLimitMiB] = useState(String(previewFileSizeLimitMiB));
  const [draftFontSizePx, setDraftFontSizePx] = useState(String(codeFontSettings.fontSizePx));
  const codeFontOptions = CODE_FONT_OPTIONS.map((option) => ({
    value: option.id,
    label: option.label
  }));
  const selectedFontLabel =
    codeFontOptions.find((option) => option.value === codeFontSettings.familyId)?.label ?? codeFontSettings.familyId;
  const previewRows: SettingsConfigRowItem[] = [
    {
      label: t("settings.files.textPreviewWindow"),
      detail: t("settings.files.textPreviewWindowDetail"),
      value: formatBytes(DEFAULT_TEXT_PREVIEW_BYTES, locale)
    },
    {
      label: t("settings.files.editLimit"),
      detail: t("settings.files.editLimitDetail"),
      value: formatBytes(MAX_EDIT_TEXT_BYTES, locale)
    },
    {
      label: t("settings.files.previewKinds"),
      detail: t("settings.files.previewKindsDetail"),
      value: t("settings.files.previewKindsValue")
    },
    {
      label: t("settings.files.mediaStreaming"),
      detail: t("settings.files.mediaStreamingDetail"),
      value: t("settings.files.rangeEnabled")
    },
    {
      label: t("settings.files.sizePolicy"),
      detail: t("settings.files.sizePolicyDetail"),
      value: t("settings.files.metadataOnly")
    }
  ];

  useEffect(() => {
    setDraftLimitMiB(String(previewFileSizeLimitMiB));
  }, [previewFileSizeLimitMiB]);

  useEffect(() => {
    setDraftFontSizePx(String(codeFontSettings.fontSizePx));
  }, [codeFontSettings.fontSizePx]);

  function changeDraftLimit(value: string) {
    setDraftLimitMiB(value);
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      onPreviewFileSizeLimitChange(previewFileSizeLimitMiBToBytes(parsed));
    }
  }

  function changeDraftFontSize(value: string) {
    setDraftFontSizePx(value);
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= MIN_CODE_FONT_SIZE_PX && parsed <= MAX_CODE_FONT_SIZE_PX) {
      onCodeFontSettingsChange({
        ...codeFontSettings,
        fontSizePx: clampCodeFontSizePx(parsed)
      });
    }
  }

  function commitDraftFontSize() {
    onCodeFontSettingsChange({
      ...codeFontSettings,
      fontSizePx: clampCodeFontSizePx(Number(draftFontSizePx))
    });
  }

  return (
    <div className="settings-content-body">
      <div className="settings-page-grid">
        <section className="settings-section-card">
          <header>
            <div>
              <h3>{t("settings.files.editorTitle")}</h3>
              <p>{t("settings.files.editorDescription")}</p>
            </div>
            <span data-state="ready">{`${codeFontSettings.fontSizePx}px`}</span>
          </header>
          <div className="settings-editor-font-grid">
            <div className="settings-preference-field">
              <span>{t("settings.files.monoFont")}</span>
              <CustomSelect
                id="code-font-family"
                value={codeFontSettings.familyId}
                options={codeFontOptions}
                ariaLabel={`${t("settings.files.monoFont")}: ${selectedFontLabel}`}
                onChange={(familyId) =>
                  onCodeFontSettingsChange({
                    ...codeFontSettings,
                    familyId
                  })
                }
              />
              <small>{t("settings.files.monoFontHelp")}</small>
            </div>
            <label className="settings-preference-field settings-size-field">
              <span>{t("settings.files.fontSize")}</span>
              <div className="settings-unit-input">
                <input
                  id="code-font-size"
                  type="number"
                  min="10"
                  max="16"
                  step="0.5"
                  inputMode="decimal"
                  value={draftFontSizePx}
                  aria-describedby="code-font-size-help"
                  onBlur={commitDraftFontSize}
                  onChange={(event) => changeDraftFontSize(event.target.value)}
                />
                <span>{t("settings.files.pixels")}</span>
              </div>
              <small id="code-font-size-help">{t("settings.files.fontSizeHelp")}</small>
            </label>
          </div>
          <pre className="settings-editor-sample" aria-hidden="true">
            <code>{'const status: "ready" = "ready";'}</code>
          </pre>
        </section>
        <section className="settings-section-card">
          <header>
            <div>
              <h3>{t("settings.files.previewTitle")}</h3>
              <p>{t("settings.files.previewDescription")}</p>
            </div>
            <span data-state="ready">{formatBytes(previewFileSizeLimitBytes, locale)}</span>
          </header>
          <label className="settings-preference-field settings-size-field">
            <span>{t("settings.files.previewFileSizeLimit")}</span>
            <div className="settings-unit-input">
              <input
                id="preview-file-size-limit"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={draftLimitMiB}
                aria-describedby="preview-file-size-limit-help"
                onBlur={() => setDraftLimitMiB(String(previewFileSizeLimitMiB))}
                onChange={(event) => changeDraftLimit(event.target.value)}
              />
              <span>{t("settings.files.megabytes")}</span>
            </div>
            <small id="preview-file-size-limit-help">
              {t("settings.files.previewFileSizeLimitHelp", {
                limit: formatBytes(previewFileSizeLimitBytes, locale)
              })}
            </small>
          </label>
        </section>

        <section className="settings-section-card">
          <header>
            <div>
              <h3>{t("settings.files.capabilitiesTitle")}</h3>
              <p>{t("settings.files.capabilitiesDescription")}</p>
            </div>
            <span data-state="ready">{t("common.states.ready")}</span>
          </header>
          <SettingsConfigRows items={previewRows} />
        </section>
      </div>
    </div>
  );
}

export function SettingsPhotostaffPage({
  settings,
  status,
  processingSettings,
  workerHealth,
  runtime,
  loading,
  locale,
  onSettingsChange,
  onClose
}: {
  settings: PhotostaffLibrarySettings | null;
  status: PhotostaffLibraryStatus | null;
  processingSettings: PhotostaffProcessingSettings | null;
  workerHealth: PhotostaffWorkerHealth | null;
  runtime: SystemInfo["sigma"]["photostaff"] | null;
  loading: boolean;
  locale: SupportedLocale;
  onSettingsChange: (patch: Partial<PhotostaffSettingsDraft>) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<PhotostaffSettingsDraft>(() => photostaffSettingsDraft(processingSettings));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(photostaffSettingsDraft(processingSettings));
    setSaved(false);
  }, [processingSettings]);

  const state: SettingsState = loading && !status
    ? "loading"
    : status?.state === "ready"
      ? "ready"
      : status && isPhotostaffActiveState(status.state)
        ? "loading"
        : "missing";
  const stateLabel = String(loading && !status
    ? t("common.states.loading")
    : status
      ? t(`settings.photostaff.states.${status.state}`)
      : t("common.states.unavailable"));
  const unavailable = String(t("common.states.unavailable"));
  const libraryRows: SettingsInfoRow[] = [
    {
      label: t("settings.photostaff.libraryPath"),
      value: settings?.path ?? t("settings.photostaff.notConfigured"),
      mono: Boolean(settings)
    },
    {
      label: t("settings.photostaff.rootId"),
      value: settings?.rootId ?? unavailable
    },
    {
      label: t("settings.photostaff.storagePoolId"),
      value: settings?.storagePoolId ?? unavailable
    },
    {
      label: t("settings.photostaff.libraryUpdatedAt"),
      value: settings ? formatDate(settings.updatedAt, locale) : unavailable
    }
  ];
  const scanRows: SettingsInfoRow[] = [
    {
      label: t("settings.photostaff.scanState"),
      value: stateLabel,
      ...(status?.error ? { detail: status.error } : {})
    },
    {
      label: t("settings.photostaff.phase"),
      value: status?.phase ? String(t(`settings.photostaff.phases.${status.phase}`)) : t("common.dash")
    },
    {
      label: t("settings.photostaff.currentPath"),
      value: status?.currentPath ?? t("common.dash"),
      mono: Boolean(status?.currentPath)
    },
    {
      label: t("settings.photostaff.statusUpdatedAt"),
      value: status?.updatedAt ? formatDate(status.updatedAt, locale) : t("common.dash")
    },
    {
      label: t("settings.photostaff.retryCount"),
      value: status ? formatLocaleNumber(status.retryCount, locale) : t("common.dash"),
      ...(status?.nextRetryAt ? { detail: t("settings.photostaff.nextRetryAt", { value: formatDate(status.nextRetryAt, locale) }) } : {})
    },
    {
      label: t("settings.photostaff.errorCode"),
      value: status?.errorCode ?? t("common.dash"),
      mono: Boolean(status?.errorCode)
    }
  ];
  const workerRows: SettingsInfoRow[] = [
    {
      label: t("settings.photostaff.workerState"),
      value: workerHealth ? String(t(`settings.photostaff.workerStates.${workerHealth.status}`)) : unavailable
    },
    {
      label: t("settings.photostaff.lastHeartbeat"),
      value: workerHealth?.lastHeartbeatAt ? formatDate(workerHealth.lastHeartbeatAt, locale) : t("common.dash")
    },
    {
      label: t("settings.photostaff.activeJobs"),
      value: workerHealth ? formatLocaleNumber(workerHealth.activeJobs, locale) : t("common.dash")
    },
    {
      label: t("settings.photostaff.pendingJobs"),
      value: workerHealth
        ? `${formatLocaleNumber(workerHealth.queuedJobs, locale)} / ${formatLocaleNumber(workerHealth.retryingJobs, locale)}`
        : t("common.dash")
    }
  ];
  const runtimeRows: SettingsInfoRow[] = [
    {
      label: t("settings.photostaff.dataDir"),
      value: runtime?.dataDir ?? unavailable,
      mono: Boolean(runtime)
    },
    {
      label: t("settings.photostaff.maxFileSize"),
      value: runtime ? formatBytes(runtime.maxFileSizeBytes, locale) : unavailable
    },
    {
      label: t("settings.photostaff.thumbnailSize"),
      value: runtime
        ? t("settings.photostaff.squarePixels", { value: formatLocaleNumber(runtime.thumbnailSizePx, locale) })
        : unavailable
    },
    {
      label: t("settings.photostaff.previewSize"),
      value: runtime
        ? t("settings.photostaff.maxEdgePixels", { value: formatLocaleNumber(runtime.previewMaxEdgePx, locale) })
        : unavailable
    },
    {
      label: t("settings.photostaff.supportedFormats"),
      value: runtime
        ? runtime.supportedExtensions.map((extension) => extension.slice(1).toUpperCase()).join(", ")
        : unavailable
    }
  ];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || loading || !processingSettings) return;
    setSaving(true);
    setSaved(false);
    try {
      await onSettingsChange(draft);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="settings-form" onSubmit={(event) => void submit(event)}>
      <div className="settings-content-body">
        <div className="settings-page-grid">
        <section className="settings-section-card">
          <header>
            <div>
              <h3>{t("settings.photostaff.libraryTitle")}</h3>
              <p>{t("settings.photostaff.libraryDescription")}</p>
            </div>
            <span data-state={settings ? "ready" : state}>{settings ? t("common.states.configured") : stateLabel}</span>
          </header>
          <SettingsInfoList rows={libraryRows} />
        </section>

        <section className="settings-section-card">
          <header>
            <div>
              <h3>{t("settings.photostaff.scanTitle")}</h3>
              <p>{t("settings.photostaff.scanDescription")}</p>
            </div>
            <span data-state={state}>{stateLabel}</span>
          </header>
          <div className="settings-metric-grid settings-system-metric-grid">
            {[
              { label: t("settings.photostaff.assets"), value: status?.total },
              { label: t("settings.photostaff.scanned"), value: status?.scanned },
              { label: t("settings.photostaff.processed"), value: status?.processed },
              { label: t("settings.photostaff.failed"), value: status?.failed }
            ].map((metric) => (
              <article key={metric.label}>
                <strong>
                  {metric.value === undefined ? t("common.dash") : formatLocaleNumber(metric.value, locale)}
                </strong>
                <span>{metric.label}</span>
              </article>
            ))}
          </div>
          <SettingsInfoList rows={scanRows} />
        </section>

        <section className="settings-section-card">
          <header>
            <div>
              <h3>{t("settings.photostaff.workerTitle")}</h3>
              <p>{t("settings.photostaff.workerDescription")}</p>
            </div>
            <span data-state={workerHealth?.status === "ready" ? "ready" : workerHealth?.status === "stale" ? "loading" : "missing"}>
              {workerHealth ? t(`settings.photostaff.workerStates.${workerHealth.status}`) : unavailable}
            </span>
          </header>
          <SettingsInfoList rows={workerRows} />
        </section>

        <section className="settings-section-card">
          <header>
            <div>
              <h3>{t("settings.photostaff.processingTitle")}</h3>
              <p>{t("settings.photostaff.processingDescription")}</p>
            </div>
            <span data-state={processingSettings ? "ready" : loading ? "loading" : "missing"}>
              {processingSettings ? t("common.states.configured") : loading ? t("common.states.loading") : unavailable}
            </span>
          </header>
          <fieldset className="settings-field-grid settings-download-fields" disabled={loading || saving || !processingSettings}>
            <DownloadNumberField label={t("settings.photostaff.processingConcurrency")} value={draft.processingConcurrency} min={1} max={4} onChange={(value) => setDraft((current) => ({ ...current, processingConcurrency: value ?? 1 }))} />
            <DownloadNumberField label={t("settings.photostaff.scanIntervalMs")} value={draft.scanIntervalMs} min={60_000} max={86_400_000} step={60_000} onChange={(value) => setDraft((current) => ({ ...current, scanIntervalMs: value ?? 60_000 }))} />
            <DownloadNumberField label={t("settings.photostaff.maxAutoRetries")} value={draft.maxAutoRetries} min={0} max={20} onChange={(value) => setDraft((current) => ({ ...current, maxAutoRetries: value ?? 0 }))} />
            <DownloadNumberField label={t("settings.photostaff.retryBaseDelayMs")} value={draft.retryBaseDelayMs} min={500} max={1_800_000} step={500} onChange={(value) => setDraft((current) => ({ ...current, retryBaseDelayMs: value ?? 500 }))} />
            <DownloadNumberField label={t("settings.photostaff.retryMaxDelayMs")} value={draft.retryMaxDelayMs} min={draft.retryBaseDelayMs} max={1_800_000} step={1_000} onChange={(value) => setDraft((current) => ({ ...current, retryMaxDelayMs: value ?? current.retryBaseDelayMs }))} />
            <DownloadNumberField label={t("settings.photostaff.commandTimeoutMs")} value={draft.commandTimeoutMs} min={5_000} max={900_000} step={1_000} onChange={(value) => setDraft((current) => ({ ...current, commandTimeoutMs: value ?? 5_000 }))} />
            <DownloadNumberField label={t("settings.photostaff.maxFileSizeBytes")} value={draft.maxFileSizeBytes} min={1024 ** 2} max={1024 ** 4} step={1024 ** 2} onChange={(value) => setDraft((current) => ({ ...current, maxFileSizeBytes: value ?? 1024 ** 2 }))} />
            <DownloadNumberField label={t("settings.photostaff.maxXmpSizeBytes")} value={draft.maxXmpSizeBytes} min={1024} max={64 * 1024 ** 2} step={1024} onChange={(value) => setDraft((current) => ({ ...current, maxXmpSizeBytes: value ?? 1024 }))} />
            <DownloadNumberField label={t("settings.photostaff.maxIntermediateBytes")} value={draft.maxIntermediateBytes} min={64 * 1024 ** 2} max={8 * 1024 ** 3} step={1024 ** 2} onChange={(value) => setDraft((current) => ({ ...current, maxIntermediateBytes: value ?? 64 * 1024 ** 2 }))} />
            <DownloadNumberField label={t("settings.photostaff.minFreeSpaceBytes")} value={draft.minFreeSpaceBytes} min={0} max={1024 ** 4} step={1024 ** 2} onChange={(value) => setDraft((current) => ({ ...current, minFreeSpaceBytes: value ?? 0 }))} />
            <DownloadNumberField label={t("settings.photostaff.maxDecodedPixels")} value={draft.maxDecodedPixels} min={1_000_000} max={268_402_689} step={1_000_000} onChange={(value) => setDraft((current) => ({ ...current, maxDecodedPixels: value ?? 1_000_000 }))} />
          </fieldset>
        </section>

        <section className="settings-section-card">
          <header>
            <div>
              <h3>{t("settings.photostaff.runtimeTitle")}</h3>
              <p>{t("settings.photostaff.runtimeDescription")}</p>
            </div>
            <span data-state={runtime ? "ready" : loading ? "loading" : "missing"}>
              {runtime ? t("settings.photostaff.readOnly") : loading ? t("common.states.loading") : unavailable}
            </span>
          </header>
          <SettingsInfoList rows={runtimeRows} />
        </section>
        </div>
      </div>

      <footer className="settings-actions">
        <span>{saved ? t("settings.photostaff.saved") : processingSettings ? t("settings.photostaff.ready") : t("common.states.unavailable")}</span>
        <div>
          <button className="secondary-button" type="button" onClick={onClose} disabled={saving}>{t("common.actions.cancel")}</button>
          <button className="primary-button" type="submit" disabled={loading || saving || !processingSettings} aria-busy={saving || undefined}>
            {saving ? t("common.actions.saving") : saved ? <><Check aria-hidden="true" size={14} />{t("settings.photostaff.saved")}</> : t("common.actions.saveChanges")}
          </button>
        </div>
      </footer>
    </form>
  );
}

type PhotostaffSettingsDraft = Omit<PhotostaffProcessingSettings, "updatedAt">;

function photostaffSettingsDraft(settings: PhotostaffProcessingSettings | null): PhotostaffSettingsDraft {
  if (settings) {
    const { updatedAt: _updatedAt, ...draft } = settings;
    return draft;
  }
  return {
    processingConcurrency: 1,
    scanIntervalMs: 1_800_000,
    maxAutoRetries: 5,
    retryBaseDelayMs: 2_000,
    retryMaxDelayMs: 300_000,
    commandTimeoutMs: 120_000,
    maxFileSizeBytes: 512 * 1024 ** 2,
    maxXmpSizeBytes: 16 * 1024 ** 2,
    maxIntermediateBytes: 2 * 1024 ** 3,
    minFreeSpaceBytes: 0,
    maxDecodedPixels: 268_402_689
  };
}

function isPhotostaffActiveState(state: PhotostaffLibraryStatus["state"]): boolean {
  return state === "queued" || state === "discovering" || state === "processing" || state === "retrying";
}

type DownloadSettingsDraft = Omit<DownloadSettings, "updatedAt">;

export function SettingsDownloadsPage({
  settings,
  loading,
  locale,
  onSettingsChange,
  onClose
}: {
  settings: DownloadSettings | null;
  loading: boolean;
  locale: SupportedLocale;
  onSettingsChange: (patch: Partial<DownloadSettingsDraft>) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<DownloadSettingsDraft>(() => downloadSettingsDraft(settings));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(downloadSettingsDraft(settings));
    setSaved(false);
  }, [settings]);

  const statusState: SettingsState = loading && !settings ? "loading" : settings ? "ready" : "missing";
  const statusLabel = loading && !settings
    ? t("common.states.loading")
    : settings
      ? t("settings.downloads.connectionCount", { count: settings.concurrency })
      : t("settings.downloads.notLoaded");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || loading) return;
    setSaving(true);
    setSaved(false);
    try {
      await onSettingsChange(draft);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="settings-form" onSubmit={(event) => void submit(event)}>
      <div className="settings-content-body">
        <div className="settings-page-grid settings-downloads-grid">
          <div className="settings-main-stack">
            <section className="settings-section-card">
              <header>
                <div>
                  <h3>{t("settings.downloads.concurrencyTitle")}</h3>
                  <p>{t("settings.downloads.concurrencyDescription")}</p>
                </div>
                <span data-state={statusState}>{statusLabel}</span>
              </header>

              <fieldset className="settings-download-control" disabled={loading || saving}>
                <label className="settings-preference-field">
                  <span>{t("settings.downloads.concurrencyField")}</span>
                  <select
                    value={String(draft.concurrency)}
                    onChange={(event) => setDraft((current) => ({
                      ...current,
                      concurrency: Number(event.target.value)
                    }))}
                  >
                    {[1, 2, 3].map((value) => (
                      <option key={value} value={value}>
                        {t("settings.downloads.connectionCount", { count: value })}
                      </option>
                    ))}
                  </select>
                  <small>{t("settings.downloads.concurrencyHelp")}</small>
                </label>
                <div className="settings-download-visual" aria-hidden="true">
                  <Download size={22} />
                  <strong>{draft.concurrency}</strong>
                  <span>{t("settings.downloads.connectionUnit")}</span>
                </div>
              </fieldset>
              <fieldset className="settings-field-grid settings-download-fields" disabled={loading || saving}>
                <DownloadNumberField
                  label={t("settings.downloads.parallelRequests")}
                  help={t("settings.downloads.parallelRequestsHelp")}
                  value={draft.parallelRequestsPerTask}
                  min={1}
                  max={8}
                  onChange={(value) => setDraft((current) => ({ ...current, parallelRequestsPerTask: value ?? 1 }))}
                />
                <DownloadNumberField
                  label={t("settings.downloads.segmentedMinBytes")}
                  help={t("settings.downloads.segmentedMinBytesHelp")}
                  value={draft.segmentedDownloadMinBytes}
                  min={1024 * 1024}
                  max={1024 ** 4}
                  step={1024 * 1024}
                  onChange={(value) => setDraft((current) => ({ ...current, segmentedDownloadMinBytes: value ?? 1024 * 1024 }))}
                />
              </fieldset>
            </section>

            <section className="settings-section-card">
              <header>
                <div>
                  <h3>{t("settings.downloads.retryTitle")}</h3>
                  <p>{t("settings.downloads.retryDescription")}</p>
                </div>
              </header>
              <fieldset className="settings-field-grid settings-download-fields" disabled={loading || saving}>
                <DownloadNumberField label={t("settings.downloads.maxAutoRetries")} value={draft.maxAutoRetries} min={0} max={20} onChange={(value) => setDraft((current) => ({ ...current, maxAutoRetries: value ?? 0 }))} />
                <DownloadNumberField label={t("settings.downloads.retryBaseDelayMs")} value={draft.retryBaseDelayMs} min={500} max={60_000} step={500} onChange={(value) => setDraft((current) => ({ ...current, retryBaseDelayMs: value ?? 500 }))} />
                <DownloadNumberField label={t("settings.downloads.retryMaxDelayMs")} value={draft.retryMaxDelayMs} min={draft.retryBaseDelayMs} max={1_800_000} step={1000} onChange={(value) => setDraft((current) => ({ ...current, retryMaxDelayMs: value ?? current.retryBaseDelayMs }))} />
                <DownloadNumberField label={t("settings.downloads.retryAfterMaxDelayMs")} value={draft.retryAfterMaxDelayMs} min={1000} max={3_600_000} step={1000} onChange={(value) => setDraft((current) => ({ ...current, retryAfterMaxDelayMs: value ?? 1000 }))} />
              </fieldset>
            </section>

            <section className="settings-section-card">
              <header>
                <div>
                  <h3>{t("settings.downloads.timeoutsTitle")}</h3>
                  <p>{t("settings.downloads.timeoutsDescription")}</p>
                </div>
              </header>
              <fieldset className="settings-field-grid settings-download-fields" disabled={loading || saving}>
                <DownloadNumberField label={t("settings.downloads.connectTimeoutMs")} value={draft.connectTimeoutMs} min={1000} max={120_000} step={1000} onChange={(value) => setDraft((current) => ({ ...current, connectTimeoutMs: value ?? 1000 }))} />
                <DownloadNumberField label={t("settings.downloads.responseHeaderTimeoutMs")} value={draft.responseHeaderTimeoutMs} min={5000} max={300_000} step={1000} onChange={(value) => setDraft((current) => ({ ...current, responseHeaderTimeoutMs: value ?? 5000 }))} />
                <DownloadNumberField label={t("settings.downloads.readIdleTimeoutMs")} value={draft.readIdleTimeoutMs} min={5000} max={900_000} step={1000} onChange={(value) => setDraft((current) => ({ ...current, readIdleTimeoutMs: value ?? 5000 }))} />
              </fieldset>
            </section>

            <section className="settings-section-card">
              <header>
                <div>
                  <h3>{t("settings.downloads.storageTitle")}</h3>
                  <p>{t("settings.downloads.storageDescription")}</p>
                </div>
              </header>
              <fieldset className="settings-field-grid settings-download-fields" disabled={loading || saving}>
                <DownloadNumberField label={t("settings.downloads.minFreeSpaceBytes")} help={t("settings.downloads.minFreeSpaceHelp")} value={draft.minFreeSpaceBytes} min={0} max={Number.MAX_SAFE_INTEGER} step={1024 * 1024} onChange={(value) => setDraft((current) => ({ ...current, minFreeSpaceBytes: value ?? 0 }))} />
                <DownloadNumberField label={t("settings.downloads.maxFileSizeBytes")} help={t("settings.downloads.maxFileSizeHelp")} value={draft.maxFileSizeBytes} min={1} max={Number.MAX_SAFE_INTEGER} step={1024 * 1024} nullable onChange={(value) => setDraft((current) => ({ ...current, maxFileSizeBytes: value }))} />
              </fieldset>
            </section>
          </div>

          <aside className="settings-side-stack" aria-label={t("settings.downloads.summaryTitle")}>
            <section className="settings-section-card settings-route-card">
              <header>
                <div>
                  <h3>{t("settings.downloads.summaryTitle")}</h3>
                  <p>{t("settings.downloads.summaryDescription")}</p>
                </div>
              </header>
              <dl className="settings-summary-list">
                <div>
                  <dt>{t("settings.downloads.concurrencyField")}</dt>
                  <dd>{settings ? t("settings.downloads.connectionCount", { count: settings.concurrency }) : t("settings.downloads.notLoaded")}</dd>
                </div>
                <div>
                  <dt>{t("settings.downloads.parallelRequests")}</dt>
                  <dd>{settings?.parallelRequestsPerTask ?? t("settings.downloads.notLoaded")}</dd>
                </div>
                <div>
                  <dt>{t("settings.downloads.segmentedMinBytes")}</dt>
                  <dd>{settings ? formatBytes(settings.segmentedDownloadMinBytes, locale) : t("settings.downloads.notLoaded")}</dd>
                </div>
                <div>
                  <dt>{t("settings.downloads.maxAutoRetries")}</dt>
                  <dd>{settings?.maxAutoRetries ?? t("settings.downloads.notLoaded")}</dd>
                </div>
                <div>
                  <dt>{t("settings.modelProvider.updated")}</dt>
                  <dd>{settingsUpdatedAtLabel(settings, locale, t)}</dd>
                </div>
              </dl>
            </section>
          </aside>
        </div>
      </div>

      <footer className="settings-actions">
        <span>
          {saved
            ? t("settings.downloads.saved")
            : settings
              ? t("settings.downloads.ready")
              : t("settings.downloads.notLoaded")}
        </span>
        <div>
          <button className="secondary-button" type="button" onClick={onClose} disabled={saving}>
            {t("common.actions.cancel")}
          </button>
          <button className="primary-button" type="submit" disabled={loading || saving || !settings} aria-busy={loading || saving || undefined}>
            {saving ? t("settings.downloads.saving") : saved ? <><Check aria-hidden="true" size={14} />{t("settings.downloads.saved")}</> : t("common.actions.saveChanges")}
          </button>
        </div>
      </footer>
    </form>
  );
}

function downloadSettingsDraft(settings: DownloadSettings | null): DownloadSettingsDraft {
  if (settings) {
    const { updatedAt: _updatedAt, ...draft } = settings;
    return draft;
  }
  return {
    concurrency: 1,
    parallelRequestsPerTask: 4,
    segmentedDownloadMinBytes: 64 * 1024 * 1024,
    maxAutoRetries: 5,
    retryBaseDelayMs: 2_000,
    retryMaxDelayMs: 300_000,
    retryAfterMaxDelayMs: 900_000,
    connectTimeoutMs: 15_000,
    responseHeaderTimeoutMs: 30_000,
    readIdleTimeoutMs: 60_000,
    minFreeSpaceBytes: 0,
    maxFileSizeBytes: null
  };
}

function DownloadNumberField({
  label,
  help,
  value,
  min,
  max,
  step = 1,
  nullable = false,
  onChange
}: {
  label: ReactNode;
  help?: ReactNode;
  value: number | null;
  min: number;
  max: number;
  step?: number;
  nullable?: boolean;
  onChange: (value: number | null) => void;
}) {
  return (
    <label className="settings-preference-field">
      <span>{label}</span>
      <input
        type="number"
        value={value ?? ""}
        min={min}
        max={max}
        step={step}
        placeholder={nullable ? "-" : undefined}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next === "" && nullable ? null : Number(next));
        }}
      />
      {help ? <small>{help}</small> : null}
    </label>
  );
}

function SettingsToolPolicyPage({
  form,
  settings,
  loading,
  saving,
  locale,
  onChange,
  onSubmit,
  onClose
}: {
  form: ToolPolicyFormState;
  settings: PiToolPolicySettings | null;
  loading: boolean;
  saving: boolean;
  locale: SupportedLocale;
  onChange: (form: ToolPolicyFormState) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const readOnlyOptions = READ_ONLY_TOOL_POLICY_OPTIONS.map((mode) => ({
    value: mode,
    label: toolPolicyModeLabel(mode, t)
  }));
  const dangerousOptions = DANGEROUS_TOOL_POLICY_OPTIONS.map((mode) => ({
    value: mode,
    label: toolPolicyModeLabel(mode, t)
  }));

  return (
    <form className="settings-form" onSubmit={onSubmit}>
      <div className="settings-content-body">
        <div className="settings-page-grid">
          <section className="settings-section-card">
            <header>
              <div>
                <h3>{t("settings.toolPolicy.readOnlyTitle")}</h3>
                <p>{t("settings.toolPolicy.readOnlyDescription")}</p>
              </div>
              <span data-state="ready">{t("common.states.configured")}</span>
            </header>
            <div className="settings-tool-policy-list">
              {READ_ONLY_TOOLS.map((tool) => (
                <label key={tool} className="settings-policy-row">
                  <span>
                    <strong>{tool}</strong>
                    <small>{t(`settings.toolPolicy.tools.${tool}`)}</small>
                  </span>
                  <CustomSelect
                    id={`tool-policy-${tool}`}
                    value={form[tool]}
                    options={readOnlyOptions}
                    ariaLabel={`${tool}: ${toolPolicyModeLabel(form[tool], t)}`}
                    onChange={(mode) =>
                      onChange({
                        ...form,
                        [tool]: mode
                      })
                    }
                    disabled={loading || saving}
                  />
                </label>
              ))}
            </div>
          </section>

          <section className="settings-section-card">
            <header>
              <div>
                <h3>{t("settings.toolPolicy.dangerousTitle")}</h3>
                <p>{t("settings.toolPolicy.dangerousDescription")}</p>
              </div>
              <span data-state="missing">{t("settings.toolPolicy.askOnly")}</span>
            </header>
            <div className="settings-tool-policy-list">
              {DANGEROUS_TOOLS.map((tool) => (
                <label key={tool} className="settings-policy-row">
                  <span>
                    <strong>{tool}</strong>
                    <small>{t(`settings.toolPolicy.tools.${tool}`)}</small>
                  </span>
                  <CustomSelect
                    id={`tool-policy-${tool}`}
                    value={form[tool]}
                    options={dangerousOptions}
                    ariaLabel={`${tool}: ${toolPolicyModeLabel(form[tool], t)}`}
                    onChange={(mode) =>
                      onChange({
                        ...form,
                        [tool]: mode
                      })
                    }
                    disabled={loading || saving}
                  />
                </label>
              ))}
            </div>
          </section>

          <section className="settings-section-card">
            <header>
              <div>
                <h3>{t("settings.toolPolicy.auditTitle")}</h3>
                <p>{t("settings.toolPolicy.auditDescription")}</p>
              </div>
            </header>
            <dl className="settings-summary-list">
              <div>
                <dt>{t("settings.toolPolicy.pendingMode")}</dt>
                <dd>{t("settings.toolPolicy.workerWaits")}</dd>
              </div>
              <div>
                <dt>{t("settings.modelProvider.updated")}</dt>
                <dd>{settings ? formatDate(settings.updatedAt, locale) : t("settings.modelProvider.notSaved")}</dd>
              </div>
            </dl>
          </section>
        </div>
      </div>

      <footer className="settings-actions">
        <span>
          {settings
            ? t("settings.toolPolicy.saved")
            : t("settings.toolPolicy.defaultsActive")}
        </span>
        <div>
          <button className="secondary-button" type="button" onClick={onClose}>
            {t("common.actions.cancel")}
          </button>
          <button className="primary-button" type="submit" disabled={loading || saving} aria-busy={loading || saving || undefined}>
            {saving ? t("common.actions.saving") : t("common.actions.saveChanges")}
          </button>
        </div>
      </footer>
    </form>
  );
}

function SettingsDockerPage({
  form,
  settings,
  loading,
  saving,
  locale,
  onChange,
  onSubmit,
  onClose
}: {
  form: DockerSettingsFormState;
  settings: DockerSettings | null;
  loading: boolean;
  saving: boolean;
  locale: SupportedLocale;
  onChange: (form: DockerSettingsFormState) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const shellCount = splitDockerShells(form.consoleShells).length;
  const statusState = loading && !settings ? "loading" : settings ? "ready" : "missing";
  const statusLabel = loading && !settings
    ? t("common.states.loading")
    : !settings
      ? t("settings.docker.notLoaded")
      : form.enabled
        ? t("settings.docker.enabled")
        : t("settings.docker.disabled");

  return (
    <form className="settings-form" onSubmit={onSubmit}>
      <div className="settings-content-body">
        <div className="settings-page-grid settings-docker-grid">
          <div className="settings-main-stack">
            <section className="settings-section-card">
              <header>
                <div>
                  <h3>{t("settings.docker.runtimeTitle")}</h3>
                  <p>{t("settings.docker.runtimeDescription")}</p>
                </div>
                <span data-state={statusState}>{statusLabel}</span>
              </header>

              <fieldset className="settings-field-grid settings-docker-runtime-grid" disabled={loading || saving}>
                <label className="settings-check settings-field-wide">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(event) =>
                      onChange({
                        ...form,
                        enabled: event.target.checked
                      })
                    }
                  />
                  <span>{t("settings.docker.enabledField")}</span>
                </label>

                <label className="settings-field-wide">
                  <span>{t("settings.docker.socketPath")}</span>
                  <input
                    value={form.socketPath}
                    onChange={(event) =>
                      onChange({
                        ...form,
                        socketPath: event.target.value
                      })
                    }
                    placeholder="/var/run/docker.sock"
                  />
                </label>

                <label className="settings-field-wide">
                  <span>{t("settings.docker.composeCommand")}</span>
                  <input
                    value={form.composeCommand}
                    onChange={(event) =>
                      onChange({
                        ...form,
                        composeCommand: event.target.value
                      })
                    }
                    placeholder="docker"
                  />
                </label>

                <label>
                  <span>{t("settings.docker.operationTimeout")}</span>
                  <input
                    type="number"
                    min="1000"
                    step="1000"
                    value={form.operationTimeoutMs}
                    onChange={(event) =>
                      onChange({
                        ...form,
                        operationTimeoutMs: event.target.value
                      })
                    }
                    placeholder="120000"
                  />
                </label>

                <label className="settings-field-wide">
                  <span>{t("settings.docker.consoleShells")}</span>
                  <textarea
                    className="settings-textarea"
                    rows={3}
                    value={form.consoleShells}
                    onChange={(event) =>
                      onChange({
                        ...form,
                        consoleShells: event.target.value
                      })
                    }
                    placeholder="/bin/sh, /bin/bash"
                  />
                  <small>{t("settings.docker.consoleShellsHelp")}</small>
                </label>
              </fieldset>

              <div className="settings-secret-note">
                <Lock aria-hidden="true" size={15} />
                <span>{t("settings.docker.socketNote")}</span>
              </div>
            </section>

          </div>

          <aside className="settings-side-stack" aria-label={t("settings.docker.summaryTitle")}>
            <section className="settings-section-card settings-route-card">
              <header>
                <div>
                  <h3>{t("settings.docker.summaryTitle")}</h3>
                  <p>{t("settings.docker.summaryDescription")}</p>
                </div>
              </header>
              <dl className="settings-summary-list">
                <div>
                  <dt>{t("settings.docker.enabledField")}</dt>
                  <dd>{settings ? (settings.enabled ? t("settings.docker.enabled") : t("settings.docker.disabled")) : t("settings.docker.notLoaded")}</dd>
                </div>
                <div>
                  <dt>{t("settings.docker.socketPath")}</dt>
                  <dd className="is-mono">{form.socketPath || t("common.dash")}</dd>
                </div>
                <div>
                  <dt>{t("settings.docker.composeCommand")}</dt>
                  <dd className="is-mono">{form.composeCommand || t("common.dash")}</dd>
                </div>
                <div>
                  <dt>{t("settings.docker.managedAppsPath")}</dt>
                  <dd className="is-mono">/srv/apps</dd>
                </div>
                <div>
                  <dt>{t("settings.docker.operationTimeout")}</dt>
                  <dd>{form.operationTimeoutMs || t("common.dash")}</dd>
                </div>
                <div>
                  <dt>{t("settings.docker.consoleShellsCount")}</dt>
                  <dd>{formatLocaleNumber(shellCount, locale)}</dd>
                </div>
                <div>
                  <dt>{t("settings.modelProvider.updated")}</dt>
                  <dd>{settingsUpdatedAtLabel(settings, locale, t)}</dd>
                </div>
              </dl>
            </section>
          </aside>
        </div>
      </div>

      <footer className="settings-actions">
        <span>{statusLabel}</span>
        <div>
          <button className="secondary-button" type="button" onClick={onClose}>
            {t("common.actions.cancel")}
          </button>
          <button className="primary-button" type="submit" disabled={loading || saving} aria-busy={loading || saving || undefined}>
            {saving ? t("common.actions.saving") : t("common.actions.saveChanges")}
          </button>
        </div>
      </footer>
    </form>
  );
}

function SettingsSecurityPage({
  settings,
  systemInfo,
  loading,
  toolPolicyForm,
  pendingApprovals,
  operations,
  operationsReady,
  locale
}: {
  settings: ModelProviderSettings | null;
  systemInfo: SystemInfo | null;
  loading: boolean;
  toolPolicyForm: ToolPolicyFormState;
  pendingApprovals: PendingApproval[];
  operations: FileOperation[];
  operationsReady: boolean;
  locale: SupportedLocale;
}) {
  const { t } = useTranslation();
  const systemState: SettingsState = systemInfo ? "ready" : loading ? "loading" : "missing";
  const systemValue = systemInfo ? null : loading ? t("common.states.loading") : t("common.states.unavailable");
  const lastOperation = operations[0] ?? null;
  const dangerousPolicySummary = DANGEROUS_TOOLS.map(
    (tool) => `${tool}: ${toolPolicyModeLabel(toolPolicyForm[tool], t)}`
  ).join(" / ");
  const secretRows: SettingsConfigRowItem[] = [
    {
      label: t("settings.security.apiKeyResponse"),
      detail: t("settings.security.apiKeyResponseDetail"),
      value: settings?.apiKeyConfigured
        ? t("settings.security.maskedBoolean")
        : t("settings.security.keyNotConfigured"),
      state: settings?.apiKeyConfigured ? "ready" : "missing"
    },
    {
      label: t("settings.security.clearKey"),
      detail: t("settings.security.clearKeyDetail"),
      value: t("common.states.configured")
    },
    {
      label: t("settings.security.publicSettings"),
      detail: t("settings.security.publicSettingsDetail"),
      value: t("settings.security.publicOnly")
    }
  ];
  const accessRows: SettingsConfigRowItem[] = [
    {
      label: t("settings.security.authMode"),
      detail: t("settings.security.authModeDetail"),
      value: systemInfo?.identity.authMode ?? systemValue ?? t("common.states.unavailable"),
      state: systemState
    },
    {
      label: t("settings.security.allowedOrigins"),
      detail: t("settings.security.allowedOriginsDetail"),
      value: systemInfo
        ? formatLocaleNumber(systemInfo.sigma.allowedOriginCount, locale)
        : systemValue ?? t("common.states.unavailable"),
      state: systemState
    },
    {
      label: t("settings.security.nasRoots"),
      detail: t("settings.security.nasRootsDetail"),
      value: systemInfo
        ? formatLocaleNumber(systemInfo.sigma.nasRoots.length, locale)
        : systemValue ?? t("common.states.unavailable"),
      state: systemState
    },
    {
      label: t("settings.security.pathSafety"),
      detail: t("settings.security.pathSafetyDetail"),
      value: t("settings.security.contained")
    }
  ];
  const approvalRows: SettingsConfigRowItem[] = [
    {
      label: t("settings.security.dangerousTools"),
      detail: t("settings.security.dangerousToolsDetail"),
      value: dangerousPolicySummary
    },
    {
      label: t("settings.security.pendingApprovals"),
      detail: t("settings.security.pendingApprovalsDetail"),
      value: formatLocaleNumber(pendingApprovals.length, locale),
      state: pendingApprovals.length > 0 ? "missing" : "ready"
    },
    {
      label: t("settings.security.operationAudit"),
      detail: t("settings.security.operationAuditDetail"),
      value: operationsReady
        ? t("settings.security.operationCount", {
            count: operations.length
          })
        : t("common.states.loading"),
      state: operationsReady ? "ready" : "loading"
    },
    {
      label: t("settings.security.latestOperation"),
      detail: t("settings.security.latestOperationDetail"),
      value: lastOperation
        ? `${lastOperation.operation} / ${formatDate(lastOperation.createdAt, locale)}`
        : t("settings.security.noOperations"),
      state: operationsReady ? "ready" : "loading"
    }
  ];

  return (
    <div className="settings-content-body">
      <div className="settings-page-grid">
        <section className="settings-section-card">
          <header>
            <div>
              <h3>{t("settings.security.secretsTitle")}</h3>
              <p>{t("settings.security.secretsDescription")}</p>
            </div>
            <span data-state={settings?.apiKeyConfigured ? "ready" : "missing"}>{settingsStatus(settings, t)}</span>
          </header>
          <SettingsConfigRows items={secretRows} />
        </section>

        <section className="settings-section-card">
          <header>
            <div>
              <h3>{t("settings.security.accessTitle")}</h3>
              <p>{t("settings.security.accessDescription")}</p>
            </div>
            <span data-state={systemState}>{systemInfo?.identity.authMode ?? systemValue}</span>
          </header>
          <SettingsConfigRows items={accessRows} />
        </section>

        <section className="settings-section-card">
          <header>
            <div>
              <h3>{t("settings.security.approvalTitle")}</h3>
              <p>{t("settings.security.approvalDescription")}</p>
            </div>
            <span data-state={pendingApprovals.length > 0 ? "missing" : "ready"}>
              {formatLocaleNumber(pendingApprovals.length, locale)}
            </span>
          </header>
          <SettingsConfigRows items={approvalRows} />
        </section>
      </div>
    </div>
  );
}

function SettingsAdvancedPage({
  systemInfo,
  loading,
  locale
}: {
  systemInfo: SystemInfo | null;
  loading: boolean;
  locale: SupportedLocale;
}) {
  const { t } = useTranslation();
  const statusState: SettingsState = systemInfo ? "ready" : loading ? "loading" : "missing";
  const statusLabel = systemInfo
    ? t("settings.system.collectedAt", { time: formatDate(systemInfo.collectedAt, locale) })
    : loading
      ? t("common.states.loading")
      : t("common.states.unavailable");

  if (!systemInfo) {
    return (
      <div className="settings-content-body">
        <div className="settings-page-grid">
          <section className="settings-section-card">
            <header>
              <div>
                <h3>{t("settings.advanced.runtimeTitle")}</h3>
                <p>{t("settings.advanced.runtimeDescription")}</p>
              </div>
              <span data-state={statusState}>{statusLabel}</span>
            </header>
          </section>
        </div>
      </div>
    );
  }

  const runtimeMemory = systemInfo.runtime.memory;
  const serviceRows: SettingsInfoRow[] = [
    {
      label: t("settings.system.labels.apiBind"),
      value: `${systemInfo.sigma.apiHost}:${systemInfo.sigma.apiPort}`
    },
    {
      label: t("settings.system.labels.allowedOrigins"),
      value: formatLocaleNumber(systemInfo.sigma.allowedOriginCount, locale)
    },
    {
      label: t("settings.system.labels.workerPoll"),
      value: t("settings.system.values.milliseconds", {
        value: formatLocaleNumber(systemInfo.sigma.workerPollMs, locale)
      })
    },
    {
      label: t("settings.system.labels.authMode"),
      value: systemInfo.identity.authMode
    },
    {
      label: t("settings.system.labels.modelMode"),
      value: systemInfo.sigma.modelProvider
    },
    {
      label: t("settings.system.labels.localEndpoint"),
      value: systemInfo.sigma.localEndpointConfigured
        ? t("settings.system.values.configured")
        : t("settings.system.values.notConfigured")
    }
  ];
  const processRows: SettingsInfoRow[] = [
    {
      label: t("settings.system.labels.nodeVersion"),
      value: systemInfo.runtime.nodeVersion
    },
    {
      label: t("settings.system.labels.pid"),
      value: formatLocaleNumber(systemInfo.runtime.pid, locale)
    },
    {
      label: t("settings.system.labels.processUptime"),
      value: formatDuration(systemInfo.runtime.uptimeSeconds, locale, t)
    },
    {
      label: t("settings.system.labels.rss"),
      value: formatBytes(runtimeMemory.rssBytes, locale)
    },
    {
      label: t("settings.system.labels.heapUsed"),
      value: `${formatBytes(runtimeMemory.heapUsedBytes, locale)} / ${formatBytes(runtimeMemory.heapTotalBytes, locale)}`
    },
    {
      label: t("settings.system.labels.cwd"),
      value: systemInfo.runtime.cwd,
      mono: true
    },
    {
      label: t("settings.system.labels.execPath"),
      value: systemInfo.runtime.execPath,
      mono: true
    }
  ];
  const pathRows: SettingsInfoRow[] = [
    {
      label: t("settings.system.labels.dataDir"),
      value: systemInfo.sigma.dataDir,
      mono: true
    },
    {
      label: t("settings.system.labels.databasePath"),
      value: systemInfo.sigma.databasePath,
      mono: true
    },
    {
      label: t("settings.system.labels.nasRoots"),
      value: formatLocaleNumber(systemInfo.sigma.nasRoots.length, locale)
    }
  ];

  return (
    <div className="settings-content-body">
      <div className="settings-page-grid">
        <SettingsInfoCard
          icon={<Server aria-hidden="true" size={17} />}
          title={t("settings.advanced.serviceTitle")}
          description={t("settings.advanced.serviceDescription")}
          rows={serviceRows}
        />

        <SettingsInfoCard
          icon={<MemoryStick aria-hidden="true" size={17} />}
          title={t("settings.advanced.processTitle")}
          description={t("settings.advanced.processDescription")}
          rows={processRows}
        >
          <div className="settings-system-chip-grid" aria-label={t("settings.system.labels.runtimeVersions")}>
            {Object.entries(systemInfo.runtime.versions).map(([name, value]) => (
              <span key={name}>
                <strong>{name}</strong>
                <em>{value}</em>
              </span>
            ))}
          </div>
        </SettingsInfoCard>

        <SettingsInfoCard
          icon={<HardDrive aria-hidden="true" size={17} />}
          title={t("settings.advanced.pathsTitle")}
          description={t("settings.advanced.pathsDescription")}
          rows={pathRows}
        >
          <div className="settings-root-list" aria-label={t("settings.system.labels.nasRoots")}>
            {systemInfo.sigma.nasRoots.map((root) => (
              <div key={root.id}>
                <strong>{root.name}</strong>
                <span>{root.id}</span>
                <small title={root.path}>{root.path}</small>
              </div>
            ))}
          </div>
        </SettingsInfoCard>
      </div>
    </div>
  );
}

function SettingsConfigRows({ items }: { items: SettingsConfigRowItem[] }) {
  return (
    <div className="settings-config-list">
      {items.map((item, index) => (
        <div key={`${item.label}-${index}`} className="settings-config-row">
          <span>
            <strong>{item.label}</strong>
            <small>{item.detail}</small>
          </span>
          <em data-state={item.state ?? "ready"}>{item.value}</em>
        </div>
      ))}
    </div>
  );
}

function storageVolumeLabel(
  volume: SystemInfoStorageVolume,
  t: Translate
): string {
  if (volume.kind === "nas-root") {
    return volume.label;
  }
  return String(t(`settings.system.storageKinds.${volume.kind}`));
}

function formatNullableBytes(
  value: number | null,
  locale: SupportedLocale,
  t: Translate
): string {
  return value === null ? String(t("common.dash")) : formatBytes(value, locale);
}

function formatDuration(
  seconds: number,
  locale: SupportedLocale,
  t: Translate
): string {
  const totalSeconds = Math.max(Math.round(seconds), 0);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (days > 0) {
    return String(t("settings.system.duration.daysHours", {
      days: formatLocaleNumber(days, locale),
      hours: formatLocaleNumber(hours, locale)
    }));
  }
  if (hours > 0) {
    return String(t("settings.system.duration.hoursMinutes", {
      hours: formatLocaleNumber(hours, locale),
      minutes: formatLocaleNumber(minutes, locale)
    }));
  }
  if (minutes > 0) {
    return String(t("settings.system.duration.minutesSeconds", {
      minutes: formatLocaleNumber(minutes, locale),
      seconds: formatLocaleNumber(remainingSeconds, locale)
    }));
  }
  return String(t("settings.system.duration.seconds", {
    seconds: formatLocaleNumber(remainingSeconds, locale)
  }));
}

function formatLoadAverage(values: number[], locale: SupportedLocale): string {
  return values
    .map((value) =>
      formatLocaleNumber(value, locale, {
        maximumFractionDigits: 2
      })
    )
    .join(" / ");
}

function formatPercent(value: number, locale: SupportedLocale): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 1
  }).format(clampPercent(value));
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(value, 0), 1);
}

function settingsSectionIcon(section: SettingsSectionId) {
  switch (section) {
    case "overview":
      return <HardDrive aria-hidden="true" size={16} />;
    case "version":
      return <Package aria-hidden="true" size={16} />;
    case "model-providers":
      return <KeyRound aria-hidden="true" size={16} />;
    case "agents":
      return <Bot aria-hidden="true" size={16} />;
    case "docker":
      return <Server aria-hidden="true" size={16} />;
    case "files":
      return <Folder aria-hidden="true" size={16} />;
    case "indexer":
      return <Database aria-hidden="true" size={16} />;
    case "operations":
      return <Activity aria-hidden="true" size={16} />;
    case "photostaff":
      return <Images aria-hidden="true" size={16} />;
    case "downloads":
      return <Download aria-hidden="true" size={16} />;
    case "security":
      return <Lock aria-hidden="true" size={16} />;
    case "appearance":
      return <ImageIcon aria-hidden="true" size={16} />;
    case "advanced":
      return <Wrench aria-hidden="true" size={16} />;
  }
}

function settingsStateIcon(state: SettingsState) {
  if (state === "ready") {
    return <Check aria-hidden="true" size={13} />;
  }
  if (state === "missing") {
    return <AlertTriangle aria-hidden="true" size={13} />;
  }
  return <Clock3 aria-hidden="true" size={13} />;
}

function languageLocaleLabel(locale: SupportedLocale, t: Translate): string {
  return String(locale === "zh-CN" ? t("common.language.chineseSimplified") : t("common.language.english"));
}

function themeResolvedLabel(theme: ResolvedTheme, t: Translate): string {
  return String(theme === "light" ? t("settings.appearance.lightTheme") : t("settings.appearance.darkTheme"));
}

function toolPolicyModeLabel(mode: string, t: Translate): string {
  if (mode === "auto") {
    return String(t("settings.toolPolicy.modes.auto"));
  }
  if (mode === "ask") {
    return String(t("settings.toolPolicy.modes.ask"));
  }
  return String(t("settings.toolPolicy.modes.disabled"));
}

function splitDockerShells(value: string): string[] {
  return value
    .split(/[\n,]/gu)
    .map((shell) => shell.trim())
    .filter(Boolean);
}
