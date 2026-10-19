import { FormEvent, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Activity,
  Bot,
  BellRing,
  Check,
  Database,
  Download,
  Folder,
  HardDrive,
  Image as ImageIcon,
  Images,
  KeyRound,
  Lock,
  MemoryStick,
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
  IndexerOverview,
  IndexerSettings,
  NasRoot,
  ModelProviderSettings,
  PhotoLibrarySettings,
  PhotoLibraryStatus,
  PhotoProcessingSettings,
  SystemInfo
} from "../../api.js";
import {
  DANGEROUS_TOOL_POLICY_OPTIONS,
  READ_ONLY_TOOL_POLICY_OPTIONS,
  SETTINGS_SECTIONS,
  providerLabel,
  settingsGroupLabel,
  settingsSectionDescription,
  settingsSectionState,
  settingsSectionTitle,
  type DockerSettingsFormState,
  type ModelProviderFormState,
  type SettingsSectionId,
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
import type { ThemePreference } from "../../lib/theme-settings.js";
import { CustomSelect } from "../common/CustomSelect.js";
import { VersionSettingsPage } from "./VersionSettingsPage.js";
import { SettingsIndexerPage } from "./SettingsIndexerPage.js";
import { SettingsOperationsPage } from "./SettingsOperationsPage.js";
import { SettingsAlertsPage } from "./SettingsAlertsPage.js";

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
  photoSettings: PhotoLibrarySettings | null;
  photoStatus: PhotoLibraryStatus | null;
  photoProcessingSettings: PhotoProcessingSettings | null;
  settings: ModelProviderSettings | null;
  systemInfo: SystemInfo | null;
  buildInfo: BuildInfo | null;
  buildInfoError: string | null;
  toolPolicyForm: ToolPolicyFormState;
  languagePreference: LanguagePreference;
  themePreference: ThemePreference;
  previewFileSizeLimitBytes: number;
  codeFontSettings: CodeFontSettings;
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
  onPhotoProcessingSettingsChange: (
    patch: Partial<Omit<PhotoProcessingSettings, "updatedAt">>
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
  photoSettings,
  photoStatus,
  photoProcessingSettings,
  settings,
  systemInfo,
  buildInfo,
  buildInfoError,
  toolPolicyForm,
  languagePreference,
  themePreference,
  previewFileSizeLimitBytes,
  codeFontSettings,
  resolvedLocale,
  onClose,
  onFormChange,
  onDockerFormChange,
  onDownloadSettingsChange,
  onIndexerSettingsChange,
  onIndexerReindex,
  onPhotoProcessingSettingsChange,
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
  const activeSectionButtonRef = useRef<HTMLButtonElement | null>(null);
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

  useEffect(() => {
    const revealActiveSection = () => {
      activeSectionButtonRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    const frame = window.requestAnimationFrame(revealActiveSection);
    window.addEventListener("resize", revealActiveSection);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", revealActiveSection);
    };
  }, [activeSection, normalizedSearch]);

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
            <img className="settings-brand-logo" src="/zos-icon.svg" alt={t("common.appName")} />
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
                    ref={section.id === activeSection ? activeSectionButtonRef : undefined}
                    key={section.id}
                    type="button"
                    className={section.id === activeSection ? "is-active" : ""}
                    onClick={() => onSectionChange(section.id)}
                  >
                    {settingsSectionIcon(section.id)}
                    <strong>{settingsSectionTitle(section, t)}</strong>
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
              <h2 id="settings-title">{settingsSectionTitle(currentSection, t)}</h2>
              <p>{settingsSectionDescription(currentSection, t)}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              title={t("common.actions.closeSettings")}
              aria-label={t("common.actions.closeSettings")}
            >
              <X aria-hidden="true" size={18} />
            </button>
          </header>

          {activeSection === "overview" ? (
            <SettingsOverview
              settings={settings}
              dockerSettings={dockerSettings}
              systemInfo={systemInfo}
              downloadSettings={downloadSettings}
              photoStatus={photoStatus}
              indexerSettings={indexerSettings}
              locale={resolvedLocale}
              onSectionChange={onSectionChange}
            />
          ) : null}

          {activeSection === "model-providers" ? (
            <form className="settings-form" onSubmit={onSubmit}>
              <div className="settings-content-body">
                <div className="settings-page-grid settings-provider-grid">
                  <section className="settings-section-card">
                    <header>
                      <div>
                        <h3>{t("settings.modelProvider.profileTitle")}</h3>
                        <p>{t("settings.modelProvider.profileDescription")}</p>
                      </div>
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
              </div>

              <footer className="settings-actions">
                <span role="status">{saving ? t("common.actions.saving") : null}</span>
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
              onLanguagePreferenceChange={onLanguagePreferenceChange}
              onThemePreferenceChange={onThemePreferenceChange}
            />
          ) : null}

          {activeSection === "agents" ? (
            <SettingsToolPolicyPage
              form={toolPolicyForm}
              loading={loading}
              saving={saving}
              onChange={onToolPolicyFormChange}
              onSubmit={onSubmit}
              onClose={onClose}
            />
          ) : null}

          {activeSection === "docker" ? (
            <SettingsDockerPage
              form={dockerForm}
              loading={loading}
              saving={saving}
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
              onSettingsChange={onIndexerSettingsChange}
              onReindex={onIndexerReindex}
              onClose={onClose}
            />
          ) : null}

          {activeSection === "operations" ? (
            <SettingsOperationsPage locale={resolvedLocale} onClose={onClose} />
          ) : null}

          {activeSection === "alerts" ? (
            <SettingsAlertsPage locale={resolvedLocale} />
          ) : null}

          {activeSection === "photos" ? (
            <SettingsPhotosPage
              settings={photoSettings}
              status={photoStatus}
              processingSettings={photoProcessingSettings}
              loading={loading}
              onSettingsChange={onPhotoProcessingSettingsChange}
              onClose={onClose}
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
  settings,
  dockerSettings,
  systemInfo,
  downloadSettings,
  photoStatus,
  indexerSettings,
  locale,
  onSectionChange
}: {
  settings: ModelProviderSettings | null;
  dockerSettings: DockerSettings | null;
  systemInfo: SystemInfo | null;
  downloadSettings: DownloadSettings | null;
  photoStatus: PhotoLibraryStatus | null;
  indexerSettings: IndexerSettings | null;
  locale: SupportedLocale;
  onSectionChange: (section: SettingsSectionId) => void;
}) {
  const { t } = useTranslation();
  const attentionIds = new Set<SettingsSectionId>([
    "model-providers",
    "docker",
    "downloads",
    "indexer",
    "photos"
  ]);
  const sectionState = (section: (typeof SETTINGS_SECTIONS)[number]) =>
    settingsSectionState(
      section,
      settings,
      dockerSettings,
      null,
      downloadSettings,
      photoStatus,
      indexerSettings
    );
  const attentionSections = SETTINGS_SECTIONS.filter(
    (section) => attentionIds.has(section.id) && sectionState(section) !== "ready"
  );
  const metricItems = [
    {
      value: systemInfo?.identity.hostname ?? String(t("common.dash")),
      label: t("settings.system.labels.hostname")
    },
    {
      value: systemInfo
        ? `${systemInfo.operatingSystem.type} ${systemInfo.operatingSystem.release}`
        : String(t("common.dash")),
      label: t("settings.system.labels.os")
    },
    {
      value: systemInfo
        ? formatDuration(systemInfo.operatingSystem.uptimeSeconds, locale, t)
        : String(t("common.dash")),
      label: t("settings.system.metrics.uptime")
    },
    {
      value: systemInfo
        ? formatLocaleNumber(systemInfo.zos.nasRoots.length, locale)
        : String(t("common.dash")),
      label: t("settings.system.metrics.nasRoots")
    }
  ];

  return (
    <div className="settings-content-body settings-overview">
      <section className="settings-section-card settings-identity-card">
        <header>
          <div>
            <h3>{t("settings.overview.systemProfile")}</h3>
            <p>{t("settings.overview.systemProfileDescription")}</p>
          </div>
        </header>
        <div className="settings-metric-grid settings-system-metric-grid">
          {metricItems.map((item) => (
            <article key={String(item.label)}>
              <strong>{item.value}</strong>
              <span>{item.label}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="settings-section-card">
        <header>
          <div>
            <h3>{t("settings.overview.attentionTitle")}</h3>
            <p>{t("settings.overview.attentionDescription")}</p>
          </div>
        </header>
        {attentionSections.length > 0 ? (
          <div className="settings-area-list">
            {attentionSections.map((section) => {
              const state = sectionState(section);
              return (
                <button key={section.id} type="button" onClick={() => onSectionChange(section.id)}>
                  {settingsSectionIcon(section.id)}
                  <span>
                    <strong>{settingsSectionTitle(section, t)}</strong>
                    <small>{settingsSectionDescription(section, t)}</small>
                  </span>
                  <em data-state={state}>
                    {state === "loading" ? t("common.states.loading") : t("settings.overview.needsAttention")}
                  </em>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="settings-empty-note">{t("settings.overview.allReady")}</p>
        )}
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

function SettingsAppearancePage({
  languagePreference,
  themePreference,
  onLanguagePreferenceChange,
  onThemePreferenceChange
}: {
  languagePreference: LanguagePreference;
  themePreference: ThemePreference;
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

  return (
    <div className="settings-content-body">
      <div className="settings-page-grid">
        <section className="settings-section-card">
          <header>
            <div>
              <h3>{t("settings.appearance.themeTitle")}</h3>
              <p>{t("settings.appearance.themeDescription")}</p>
            </div>
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

      </div>
    </div>
  );
}

export function SettingsPhotosPage({
  settings,
  status,
  processingSettings,
  loading,
  onSettingsChange,
  onClose
}: {
  settings: PhotoLibrarySettings | null;
  status: PhotoLibraryStatus | null;
  processingSettings: PhotoProcessingSettings | null;
  loading: boolean;
  onSettingsChange: (patch: Partial<PhotoSettingsDraft>) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<PhotoSettingsDraft>(() => photoSettingsDraft(processingSettings));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(photoSettingsDraft(processingSettings));
    setSaved(false);
  }, [processingSettings]);

  const stateLabel = String(loading && !status
    ? t("common.states.loading")
    : status
      ? t(`settings.photos.states.${status.state}`)
      : t("common.states.unavailable"));
  const hasStatusProblem = !settings || Boolean(status?.error) ||
    status?.state === "degraded" || status?.state === "offline" || status?.state === "unconfigured";

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
                <h3>{t("settings.photos.libraryTitle")}</h3>
                <p>{t("settings.photos.libraryDescription")}</p>
              </div>
            </header>
            <dl className="settings-summary-list settings-photo-context">
              <div>
                <dt>{t("settings.photos.libraryPath")}</dt>
                <dd className={settings ? "is-mono" : undefined}>
                  {settings?.path ?? t("settings.photos.notConfigured")}
                </dd>
              </div>
            </dl>
            {hasStatusProblem ? (
              <p className="settings-inline-alert" role="alert">
                <AlertTriangle aria-hidden="true" size={15} />
                <span>{status?.error ?? stateLabel}</span>
              </p>
            ) : null}
          </section>

          <section className="settings-section-card">
            <header>
              <div>
                <h3>{t("settings.photos.processingTitle")}</h3>
                <p>{t("settings.photos.processingDescription")}</p>
              </div>
            </header>
            <fieldset className="settings-field-grid settings-download-fields" disabled={loading || saving || !processingSettings}>
              <DownloadNumberField label={t("settings.photos.processingConcurrency")} value={draft.processingConcurrency} min={1} max={4} onChange={(value) => setDraft((current) => ({ ...current, processingConcurrency: value ?? 1 }))} />
              <DownloadNumberField label={t("settings.photos.scanIntervalMs")} value={draft.scanIntervalMs} min={60_000} max={86_400_000} step={60_000} onChange={(value) => setDraft((current) => ({ ...current, scanIntervalMs: value ?? 60_000 }))} />
              <DownloadNumberField label={t("settings.photos.commandTimeoutMs")} value={draft.commandTimeoutMs} min={5_000} max={900_000} step={1_000} onChange={(value) => setDraft((current) => ({ ...current, commandTimeoutMs: value ?? 5_000 }))} />
            </fieldset>
          </section>

          <section className="settings-section-card">
            <header>
              <div>
                <h3>{t("settings.photos.retryPolicyTitle")}</h3>
                <p>{t("settings.photos.retryPolicyDescription")}</p>
              </div>
            </header>
            <fieldset className="settings-field-grid settings-download-fields" disabled={loading || saving || !processingSettings}>
              <DownloadNumberField label={t("settings.photos.maxAutoRetries")} value={draft.maxAutoRetries} min={0} max={20} onChange={(value) => setDraft((current) => ({ ...current, maxAutoRetries: value ?? 0 }))} />
              <DownloadNumberField label={t("settings.photos.retryBaseDelayMs")} value={draft.retryBaseDelayMs} min={500} max={1_800_000} step={500} onChange={(value) => setDraft((current) => ({ ...current, retryBaseDelayMs: value ?? 500 }))} />
              <DownloadNumberField label={t("settings.photos.retryMaxDelayMs")} value={draft.retryMaxDelayMs} min={draft.retryBaseDelayMs} max={1_800_000} step={1_000} onChange={(value) => setDraft((current) => ({ ...current, retryMaxDelayMs: value ?? current.retryBaseDelayMs }))} />
            </fieldset>
          </section>

          <section className="settings-section-card">
            <header>
              <div>
                <h3>{t("settings.photos.resourceLimitsTitle")}</h3>
                <p>{t("settings.photos.resourceLimitsDescription")}</p>
              </div>
            </header>
            <fieldset className="settings-field-grid settings-download-fields" disabled={loading || saving || !processingSettings}>
              <DownloadNumberField label={t("settings.photos.maxFileSizeBytes")} value={draft.maxFileSizeBytes} min={1024 ** 2} max={1024 ** 4} step={1024 ** 2} onChange={(value) => setDraft((current) => ({ ...current, maxFileSizeBytes: value ?? 1024 ** 2 }))} />
              <DownloadNumberField label={t("settings.photos.maxXmpSizeBytes")} value={draft.maxXmpSizeBytes} min={1024} max={64 * 1024 ** 2} step={1024} onChange={(value) => setDraft((current) => ({ ...current, maxXmpSizeBytes: value ?? 1024 }))} />
              <DownloadNumberField label={t("settings.photos.maxIntermediateBytes")} value={draft.maxIntermediateBytes} min={64 * 1024 ** 2} max={8 * 1024 ** 3} step={1024 ** 2} onChange={(value) => setDraft((current) => ({ ...current, maxIntermediateBytes: value ?? 64 * 1024 ** 2 }))} />
              <DownloadNumberField label={t("settings.photos.minFreeSpaceBytes")} value={draft.minFreeSpaceBytes} min={0} max={1024 ** 4} step={1024 ** 2} onChange={(value) => setDraft((current) => ({ ...current, minFreeSpaceBytes: value ?? 0 }))} />
              <DownloadNumberField label={t("settings.photos.maxDecodedPixels")} value={draft.maxDecodedPixels} min={1_000_000} max={268_402_689} step={1_000_000} onChange={(value) => setDraft((current) => ({ ...current, maxDecodedPixels: value ?? 1_000_000 }))} />
            </fieldset>
          </section>
        </div>
      </div>

      <footer className="settings-actions">
        <span role="status">
          {saving
            ? t("common.actions.saving")
            : saved
              ? t("settings.photos.saved")
              : !loading && !processingSettings
                ? t("common.states.unavailable")
                : null}
        </span>
        <div>
          <button className="secondary-button" type="button" onClick={onClose} disabled={saving}>{t("common.actions.cancel")}</button>
          <button className="primary-button" type="submit" disabled={loading || saving || !processingSettings} aria-busy={saving || undefined}>
            {saving ? t("common.actions.saving") : saved ? <><Check aria-hidden="true" size={14} />{t("settings.photos.saved")}</> : t("common.actions.saveChanges")}
          </button>
        </div>
      </footer>
    </form>
  );
}

type PhotoSettingsDraft = Omit<PhotoProcessingSettings, "updatedAt">;

function photoSettingsDraft(settings: PhotoProcessingSettings | null): PhotoSettingsDraft {
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

type DownloadSettingsDraft = Omit<DownloadSettings, "updatedAt">;

export function SettingsDownloadsPage({
  settings,
  loading,
  onSettingsChange,
  onClose
}: {
  settings: DownloadSettings | null;
  loading: boolean;
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
            <section className="settings-section-card">
              <header>
                <div>
                  <h3>{t("settings.downloads.concurrencyTitle")}</h3>
                  <p>{t("settings.downloads.concurrencyDescription")}</p>
                </div>
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
      </div>

      <footer className="settings-actions">
        <span role="status">
          {saving
            ? t("settings.downloads.saving")
            : saved
              ? t("settings.downloads.saved")
              : !loading && !settings
                ? t("settings.downloads.notLoaded")
                : null}
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
  loading,
  saving,
  onChange,
  onSubmit,
  onClose
}: {
  form: ToolPolicyFormState;
  loading: boolean;
  saving: boolean;
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

        </div>
      </div>

      <footer className="settings-actions">
        <span role="status">{saving ? t("common.actions.saving") : null}</span>
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
  loading,
  saving,
  onChange,
  onSubmit,
  onClose
}: {
  form: DockerSettingsFormState;
  loading: boolean;
  saving: boolean;
  onChange: (form: DockerSettingsFormState) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  return (
    <form className="settings-form" onSubmit={onSubmit}>
      <div className="settings-content-body">
        <div className="settings-page-grid settings-docker-grid">
            <section className="settings-section-card">
              <header>
                <div>
                  <h3>{t("settings.docker.runtimeTitle")}</h3>
                  <p>{t("settings.docker.runtimeDescription")}</p>
                </div>
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
      </div>

      <footer className="settings-actions">
        <span role="status">{saving ? t("common.actions.saving") : null}</span>
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
            </header>
            <p className="settings-inline-alert" role="status">{statusLabel}</p>
          </section>
        </div>
      </div>
    );
  }

  const runtimeMemory = systemInfo.runtime.memory;
  const serviceRows: SettingsInfoRow[] = [
    {
      label: t("settings.system.labels.apiBind"),
      value: `${systemInfo.zos.apiHost}:${systemInfo.zos.apiPort}`
    },
    {
      label: t("settings.system.labels.allowedOrigins"),
      value: formatLocaleNumber(systemInfo.zos.allowedOriginCount, locale)
    },
    {
      label: t("settings.system.labels.workerPoll"),
      value: t("settings.system.values.milliseconds", {
        value: formatLocaleNumber(systemInfo.zos.workerPollMs, locale)
      })
    },
    {
      label: t("settings.system.labels.authMode"),
      value: systemInfo.identity.authMode
    },
    {
      label: t("settings.system.labels.modelMode"),
      value: systemInfo.zos.modelProvider
    },
    {
      label: t("settings.system.labels.localEndpoint"),
      value: systemInfo.zos.localEndpointConfigured
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
      value: systemInfo.zos.dataDir,
      mono: true
    },
    {
      label: t("settings.system.labels.databasePath"),
      value: systemInfo.zos.databasePath,
      mono: true
    },
    {
      label: t("settings.system.labels.nasRoots"),
      value: formatLocaleNumber(systemInfo.zos.nasRoots.length, locale)
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
        />

        <SettingsInfoCard
          icon={<HardDrive aria-hidden="true" size={17} />}
          title={t("settings.advanced.pathsTitle")}
          description={t("settings.advanced.pathsDescription")}
          rows={pathRows}
        >
          <div className="settings-root-list" aria-label={t("settings.system.labels.nasRoots")}>
            {systemInfo.zos.nasRoots.map((root) => (
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
    case "alerts":
      return <BellRing aria-hidden="true" size={16} />;
    case "photos":
      return <Images aria-hidden="true" size={16} />;
    case "downloads":
      return <Download aria-hidden="true" size={16} />;
    case "appearance":
      return <ImageIcon aria-hidden="true" size={16} />;
    case "advanced":
      return <Wrench aria-hidden="true" size={16} />;
  }
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
