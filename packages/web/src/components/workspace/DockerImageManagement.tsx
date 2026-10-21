import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  Download,
  Image as ImageIcon,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  X
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  createDockerRegistry,
  deleteDockerRegistry,
  getDockerRegistries,
  pullDockerImage,
  removeDockerImage,
  updateDockerRegistry,
  type DockerImageSummary,
  type DockerRegistryCredential
} from "../../api.js";
import { formatBytes } from "../../i18n/format.js";
import type { SupportedLocale } from "../../i18n/locale.js";
import {
  dockerImageDeleteTargets,
  dockerImageDisplayName,
  dockerImageRemovalBlocked,
  filterDockerImages,
  isValidDockerImageReference,
  matchingDockerRegistry
} from "../../lib/docker-images.js";
import { dockerImageUsage, sortDockerImages } from "../../lib/docker-inventory.js";
import { useModalDialog } from "./useModalDialog.js";

interface DockerImageManagementProps {
  images: DockerImageSummary[];
  engineReady: boolean;
  engineError: string | null;
  locale: SupportedLocale;
  onRefreshSummary: () => Promise<void>;
  onNotifySuccess: (message: string) => void;
  onNotifyError: (message: string) => void;
}

interface RegistryFormState {
  name: string;
  serverAddress: string;
  username: string;
  password: string;
}

const EMPTY_REGISTRY_FORM: RegistryFormState = {
  name: "",
  serverAddress: "",
  username: "",
  password: ""
};

export function DockerImageManagement({
  images,
  engineReady,
  engineError,
  locale,
  onRefreshSummary,
  onNotifySuccess,
  onNotifyError
}: DockerImageManagementProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [selectedImage, setSelectedImage] = useState<DockerImageSummary | null>(null);
  const [deleteReference, setDeleteReference] = useState("");
  const [deleteConfirming, setDeleteConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [pullOpen, setPullOpen] = useState(false);
  const [pullReference, setPullReference] = useState("");
  const [pulling, setPulling] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);
  const [registries, setRegistries] = useState<DockerRegistryCredential[]>([]);
  const [registriesLoading, setRegistriesLoading] = useState(true);
  const [registriesError, setRegistriesError] = useState<string | null>(null);
  const [registryOpen, setRegistryOpen] = useState(false);
  const visibleImages = useMemo(() => filterDockerImages(sortDockerImages(images), query), [images, query]);
  const matchedRegistry = useMemo(
    () => isValidDockerImageReference(pullReference)
      ? matchingDockerRegistry(pullReference, registries)
      : null,
    [pullReference, registries]
  );

  useEffect(() => {
    void loadRegistries();
  }, []);

  async function loadRegistries() {
    setRegistriesLoading(true);
    setRegistriesError(null);
    try {
      setRegistries(await getDockerRegistries());
    } catch (error) {
      setRegistriesError(errorMessage(error));
    } finally {
      setRegistriesLoading(false);
    }
  }

  function openDetails(image: DockerImageSummary) {
    setSelectedImage(image);
    setDeleteReference(dockerImageDeleteTargets(image)[0] ?? image.id);
    setDeleteConfirming(false);
    setImageError(null);
  }

  async function submitPull(event: FormEvent) {
    event.preventDefault();
    if (pulling || !engineReady || !isValidDockerImageReference(pullReference)) return;
    setPulling(true);
    setPullError(null);
    try {
      await pullDockerImage({ reference: pullReference.trim() });
      await onRefreshSummary();
      onNotifySuccess(String(t("workspace.management.docker.images.pullSucceeded", { reference: pullReference.trim() })));
      setPullOpen(false);
      setPullReference("");
    } catch (error) {
      const message = errorMessage(error);
      setPullError(message);
      onNotifyError(message);
    } finally {
      setPulling(false);
    }
  }

  async function confirmDelete() {
    if (deleting || !engineReady || !selectedImage || !deleteReference || dockerImageRemovalBlocked(selectedImage)) return;
    setDeleting(true);
    setImageError(null);
    try {
      await removeDockerImage({ reference: deleteReference, confirmed: true });
      await onRefreshSummary();
      onNotifySuccess(String(t("workspace.management.docker.images.removeSucceeded", { reference: deleteReference })));
      setSelectedImage(null);
      setDeleteConfirming(false);
    } catch (error) {
      const message = errorMessage(error);
      setImageError(message);
      onNotifyError(message);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <section className="management-section management-table-section docker-image-section">
        <header className="management-section-header docker-image-section-header">
          <div>
            <h3>{t("workspace.management.docker.images.title")}</h3>
            <p>{t("workspace.management.docker.images.description")}</p>
          </div>
          <div className="docker-image-toolbar">
            <label className="docker-image-search">
              <Search aria-hidden="true" size={14} />
              <span className="visually-hidden">{t("workspace.management.docker.images.search")}</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("workspace.management.docker.images.searchPlaceholder")}
              />
            </label>
            <button
              type="button"
              onClick={() => {
                setPullError(null);
                setPullOpen(true);
              }}
              disabled={!engineReady}
            >
              <Download aria-hidden="true" size={14} />
              <span>{t("workspace.management.docker.images.pull")}</span>
            </button>
            <button type="button" onClick={() => setRegistryOpen(true)}>
              <KeyRound aria-hidden="true" size={14} />
              <span>{t("workspace.management.docker.images.registries")}</span>
            </button>
          </div>
        </header>

        {!engineReady && engineError ? (
          <div className="docker-image-engine-note" role="status">
            <AlertTriangle aria-hidden="true" size={15} />
            <span>{engineError}</span>
          </div>
        ) : null}

        {visibleImages.length ? (
          <div className="management-table-wrap">
            <table className="management-table docker-image-table">
              <thead>
                <tr>
                  <th>{t("workspace.management.docker.images.columns.repository")}</th>
                  <th>{t("workspace.management.docker.images.columns.id")}</th>
                  <th>{t("workspace.management.docker.images.columns.created")}</th>
                  <th>{t("workspace.management.docker.images.columns.size")}</th>
                  <th>{t("workspace.management.docker.images.columns.architecture")}</th>
                  <th>{t("workspace.management.docker.images.columns.usage")}</th>
                </tr>
              </thead>
              <tbody>
                {visibleImages.map((image) => (
                  <tr key={image.id}>
                    <td data-label={t("workspace.management.docker.images.columns.repository")} title={dockerImageDisplayName(image)}>
                      <button type="button" className="docker-image-name-trigger" onClick={() => openDetails(image)}>
                        <span>{dockerImageDisplayName(image)}</span>
                        <ArrowUpRight aria-hidden="true" size={13} />
                      </button>
                      {image.tags.length > 1 ? (
                        <small>{t("workspace.management.docker.images.moreTags", { count: image.tags.length - 1 })}</small>
                      ) : null}
                    </td>
                    <td data-label={t("workspace.management.docker.images.columns.id")}><code>{image.shortId}</code></td>
                    <td data-label={t("workspace.management.docker.images.columns.created")}>{formatDockerDate(image.createdAt, locale, String(t("common.dash")))}</td>
                    <td data-label={t("workspace.management.docker.images.columns.size")}>{formatBytes(image.sizeBytes, locale)}</td>
                    <td data-label={t("workspace.management.docker.images.columns.architecture")}>{image.architecture ?? t("common.dash")}</td>
                    <td data-label={t("workspace.management.docker.images.columns.usage")}>{t(dockerImageUsageTranslationKey(image))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="management-empty management-table-empty-state">
            {query
              ? t("workspace.management.docker.images.noMatches")
              : engineReady
                ? t("workspace.management.docker.images.empty")
                : t("workspace.management.docker.images.unavailable")}
          </p>
        )}
      </section>

      {selectedImage ? (
        <DockerImageDetailsDialog
          image={selectedImage}
          locale={locale}
          engineReady={engineReady}
          deleteReference={deleteReference}
          deleteConfirming={deleteConfirming}
          deleting={deleting}
          error={imageError}
          onDeleteReference={setDeleteReference}
          onBeginDelete={() => setDeleteConfirming(true)}
          onCancelDelete={() => setDeleteConfirming(false)}
          onConfirmDelete={() => void confirmDelete()}
          onClose={() => setSelectedImage(null)}
        />
      ) : null}

      {pullOpen ? (
        <DockerImagePullDialog
          reference={pullReference}
          registry={matchedRegistry}
          engineReady={engineReady}
          submitting={pulling}
          error={pullError}
          onReference={setPullReference}
          onSubmit={submitPull}
          onClose={() => setPullOpen(false)}
        />
      ) : null}

      {registryOpen ? (
        <DockerRegistryDialog
          registries={registries}
          loading={registriesLoading}
          loadError={registriesError}
          onReload={loadRegistries}
          onRegistries={setRegistries}
          onNotifySuccess={onNotifySuccess}
          onNotifyError={onNotifyError}
          onClose={() => setRegistryOpen(false)}
        />
      ) : null}
    </>
  );
}

export function DockerImageDetailsDialog({
  image,
  locale,
  engineReady,
  deleteReference,
  deleteConfirming,
  deleting,
  error,
  onDeleteReference,
  onBeginDelete,
  onCancelDelete,
  onConfirmDelete,
  onClose
}: {
  image: DockerImageSummary;
  locale: SupportedLocale;
  engineReady: boolean;
  deleteReference: string;
  deleteConfirming: boolean;
  deleting: boolean;
  error: string | null;
  onDeleteReference: (reference: string) => void;
  onBeginDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const targets = dockerImageDeleteTargets(image);
  const occupied = typeof image.containerCount === "number" && image.containerCount > 0;
  const removalBlocked = dockerImageRemovalBlocked(image);
  const dialogRef = useModalDialog(onClose, deleting);
  return (
    <div className="management-modal-backdrop docker-image-modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !deleting) onClose();
    }}>
      <section ref={dialogRef} tabIndex={-1} className="management-modal docker-image-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="docker-image-detail-title">
        <header>
          <div className="docker-image-dialog-heading">
            <span className="docker-image-dialog-icon"><ImageIcon aria-hidden="true" size={19} /></span>
            <div>
              <span className="eyebrow">{t("workspace.management.docker.images.detailsEyebrow")}</span>
              <h2 id="docker-image-detail-title">{dockerImageDisplayName(image)}</h2>
            </div>
          </div>
          <button type="button" className="management-icon-action" onClick={onClose} disabled={deleting} aria-label={t("common.actions.close")}><X aria-hidden="true" size={17} /></button>
        </header>

        {deleteConfirming ? (
          <div className="docker-image-confirmation">
            <AlertTriangle aria-hidden="true" size={24} />
            <div>
              <h3>{t("workspace.management.docker.images.confirmRemoveTitle")}</h3>
              <p>{t("workspace.management.docker.images.confirmRemoveDescription")}</p>
            </div>
            {targets.length > 1 ? (
              <label>
                <span>{t("workspace.management.docker.images.removeReference")}</span>
                <select value={deleteReference} onChange={(event) => onDeleteReference(event.target.value)} disabled={deleting}>
                  {targets.map((target) => <option key={target} value={target}>{target}</option>)}
                </select>
              </label>
            ) : (
              <code>{deleteReference}</code>
            )}
            {error ? <p className="docker-image-error">{error}</p> : null}
          </div>
        ) : (
          <div className="docker-image-detail-body">
            <dl className="docker-image-detail-grid">
              <div><dt>{t("workspace.management.docker.images.fullId")}</dt><dd><code>{image.id}</code></dd></div>
              <div><dt>{t("workspace.management.docker.images.columns.created")}</dt><dd>{formatDockerDate(image.createdAt, locale, String(t("common.dash")))}</dd></div>
              <div><dt>{t("workspace.management.docker.images.columns.size")}</dt><dd>{formatBytes(image.sizeBytes, locale)}</dd></div>
              <div><dt>{t("workspace.management.docker.images.sharedSize")}</dt><dd>{image.sharedSizeBytes === null ? t("common.dash") : formatBytes(image.sharedSizeBytes, locale)}</dd></div>
              <div><dt>{t("workspace.management.docker.images.columns.architecture")}</dt><dd>{image.architecture ?? t("common.dash")}</dd></div>
              <div><dt>{t("workspace.management.docker.images.columns.usage")}</dt><dd>{t(dockerImageUsageTranslationKey(image))}</dd></div>
            </dl>
            <ImageReferenceList title={String(t("workspace.management.docker.images.tags"))} values={image.tags} empty={String(t("workspace.management.docker.images.noTags"))} />
            <ImageReferenceList title={String(t("workspace.management.docker.images.digests"))} values={image.digests} empty={String(t("workspace.management.docker.images.noDigests"))} />
            {occupied ? <p className="docker-image-engine-note"><AlertTriangle aria-hidden="true" size={15} /><span>{t("workspace.management.docker.images.inUse")}</span></p> : null}
            {image.containerCount === null ? <p className="docker-image-engine-note"><AlertTriangle aria-hidden="true" size={15} /><span>{t("workspace.management.docker.images.occupancyUnknown")}</span></p> : null}
            {error ? <p className="docker-image-error">{error}</p> : null}
          </div>
        )}

        <footer className="docker-image-dialog-footer">
          {deleteConfirming ? (
            <>
              <button type="button" onClick={onCancelDelete} disabled={deleting}>{t("common.actions.cancel")}</button>
              <button type="button" className="is-danger" onClick={onConfirmDelete} disabled={!engineReady || removalBlocked || deleting} aria-busy={deleting || undefined}>
                {deleting ? <LoaderCircle aria-hidden="true" size={15} /> : <Trash2 aria-hidden="true" size={15} />}
                <span>{t("workspace.management.docker.images.confirmRemove")}</span>
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={onClose}>{t("common.actions.close")}</button>
              <button type="button" className="is-danger" onClick={onBeginDelete} disabled={!engineReady || removalBlocked}>
                <Trash2 aria-hidden="true" size={15} />
                <span>{t("workspace.management.docker.images.remove")}</span>
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}

function ImageReferenceList({ title, values, empty }: { title: string; values: string[]; empty: string }) {
  return (
    <section className="docker-image-reference-list">
      <h3>{title}</h3>
      {values.length ? values.map((value) => <code key={value}>{value}</code>) : <span>{empty}</span>}
    </section>
  );
}

function DockerImagePullDialog({
  reference,
  registry,
  engineReady,
  submitting,
  error,
  onReference,
  onSubmit,
  onClose
}: {
  reference: string;
  registry: DockerRegistryCredential | null;
  engineReady: boolean;
  submitting: boolean;
  error: string | null;
  onReference: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const valid = isValidDockerImageReference(reference);
  return (
    <div className="management-modal-backdrop docker-image-modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !submitting) onClose();
    }}>
      <form className="management-modal docker-image-pull-dialog" role="dialog" aria-modal="true" aria-labelledby="docker-image-pull-title" onSubmit={onSubmit}>
        <header>
          <div>
            <span className="eyebrow">{t("workspace.management.docker.images.pullEyebrow")}</span>
            <h2 id="docker-image-pull-title">{t("workspace.management.docker.images.pullTitle")}</h2>
          </div>
          <button type="button" className="management-icon-action" onClick={onClose} disabled={submitting} aria-label={t("common.actions.close")}><X aria-hidden="true" size={17} /></button>
        </header>
        <div className="docker-image-pull-body">
          <label className="docker-registry-field">
            <span>{t("workspace.management.docker.images.reference")}</span>
            <input value={reference} onChange={(event) => onReference(event.target.value)} disabled={submitting} autoFocus placeholder="registry.example.com/team/app:latest" />
          </label>
          <div className="docker-image-registry-match" data-state={registry ? "ready" : "neutral"}>
            {registry ? <ShieldCheck aria-hidden="true" size={17} /> : <KeyRound aria-hidden="true" size={17} />}
            <div>
              <strong>{registry ? registry.name : t("workspace.management.docker.images.anonymous")}</strong>
              <span>{registry ? `${registry.serverAddress} · ${registry.username}` : t("workspace.management.docker.images.noMatchedRegistry")}</span>
            </div>
          </div>
          {!engineReady ? <p className="docker-image-error">{t("workspace.management.docker.images.engineRequired")}</p> : null}
          {reference && !valid ? <p className="docker-image-error">{t("workspace.management.docker.images.invalidReference")}</p> : null}
          {error ? <p className="docker-image-error">{error}</p> : null}
        </div>
        <footer className="docker-image-dialog-footer">
          <button type="button" onClick={onClose} disabled={submitting}>{t("common.actions.cancel")}</button>
          <button type="submit" className="is-primary" disabled={!engineReady || !valid || submitting} aria-busy={submitting || undefined}>
            {submitting ? <LoaderCircle aria-hidden="true" size={15} /> : <Download aria-hidden="true" size={15} />}
            <span>{submitting ? t("workspace.management.docker.images.pulling") : t("workspace.management.docker.images.pull")}</span>
          </button>
        </footer>
      </form>
    </div>
  );
}

function DockerRegistryDialog({
  registries,
  loading,
  loadError,
  onReload,
  onRegistries,
  onNotifySuccess,
  onNotifyError,
  onClose
}: {
  registries: DockerRegistryCredential[];
  loading: boolean;
  loadError: string | null;
  onReload: () => Promise<void>;
  onRegistries: (registries: DockerRegistryCredential[]) => void;
  onNotifySuccess: (message: string) => void;
  onNotifyError: (message: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<DockerRegistryCredential | "new" | null>(null);
  const [form, setForm] = useState<RegistryFormState>(EMPTY_REGISTRY_FORM);
  const [deleteCandidate, setDeleteCandidate] = useState<DockerRegistryCredential | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formValid = Boolean(
    form.name.trim() &&
    form.serverAddress.trim() &&
    form.username.trim() &&
    (editing !== "new" || form.password.trim())
  );

  function startCreate() {
    setEditing("new");
    setForm(EMPTY_REGISTRY_FORM);
    setError(null);
  }

  function startEdit(registry: DockerRegistryCredential) {
    setEditing(registry);
    setForm({
      name: registry.name,
      serverAddress: registry.serverAddress,
      username: registry.username,
      password: ""
    });
    setError(null);
  }

  async function saveRegistry(event: FormEvent) {
    event.preventDefault();
    if (submitting || !editing || !formValid) return;
    setSubmitting(true);
    setError(null);
    try {
      const input = {
        name: form.name.trim(),
        serverAddress: form.serverAddress.trim(),
        username: form.username.trim(),
        ...(form.password ? { password: form.password } : {})
      };
      const saved = editing === "new"
        ? await createDockerRegistry({ ...input, password: form.password })
        : await updateDockerRegistry(editing.id, input);
      onRegistries(editing === "new"
        ? [...registries, saved]
        : registries.map((registry) => registry.id === saved.id ? saved : registry));
      onNotifySuccess(String(t("workspace.management.docker.images.registrySaved")));
      setEditing(null);
      setForm(EMPTY_REGISTRY_FORM);
    } catch (nextError) {
      const message = errorMessage(nextError);
      setError(message);
      onNotifyError(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmRegistryDelete() {
    if (submitting || !deleteCandidate) return;
    setSubmitting(true);
    setError(null);
    try {
      await deleteDockerRegistry(deleteCandidate.id);
      onRegistries(registries.filter((registry) => registry.id !== deleteCandidate.id));
      onNotifySuccess(String(t("workspace.management.docker.images.registryDeleted")));
      setDeleteCandidate(null);
    } catch (nextError) {
      const message = errorMessage(nextError);
      setError(message);
      onNotifyError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="management-modal-backdrop docker-image-modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !submitting) onClose();
    }}>
      <section className="management-modal docker-registry-dialog" role="dialog" aria-modal="true" aria-labelledby="docker-registry-title">
        <header>
          <div>
            <span className="eyebrow">{t("workspace.management.docker.images.registryEyebrow")}</span>
            <h2 id="docker-registry-title">{t("workspace.management.docker.images.registryTitle")}</h2>
          </div>
          <button type="button" className="management-icon-action" onClick={onClose} disabled={submitting} aria-label={t("common.actions.close")}><X aria-hidden="true" size={17} /></button>
        </header>

        {deleteCandidate ? (
          <div className="docker-image-confirmation">
            <AlertTriangle aria-hidden="true" size={24} />
            <div>
              <h3>{t("workspace.management.docker.images.confirmRegistryDeleteTitle")}</h3>
              <p>{t("workspace.management.docker.images.confirmRegistryDeleteDescription", { name: deleteCandidate.name })}</p>
            </div>
            <code>{deleteCandidate.serverAddress}</code>
            {error ? <p className="docker-image-error">{error}</p> : null}
          </div>
        ) : editing ? (
          <form id="docker-registry-form" className="docker-registry-form" onSubmit={saveRegistry}>
            <label className="docker-registry-field"><span>{t("workspace.management.docker.images.registryName")}</span><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} disabled={submitting} autoFocus /></label>
            <label className="docker-registry-field"><span>{t("workspace.management.docker.images.serverAddress")}</span><input value={form.serverAddress} onChange={(event) => setForm({ ...form, serverAddress: event.target.value })} disabled={submitting} placeholder="docker.io" /></label>
            <label className="docker-registry-field"><span>{t("workspace.management.docker.images.username")}</span><input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} disabled={submitting} autoComplete="username" /></label>
            <label className="docker-registry-field"><span>{t("workspace.management.docker.images.password")}</span><input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} disabled={submitting} autoComplete="new-password" placeholder={editing === "new" ? "" : String(t("workspace.management.docker.images.passwordConfigured"))} /></label>
            {editing !== "new" ? <p className="docker-registry-password-note"><Check aria-hidden="true" size={14} />{t("workspace.management.docker.images.passwordKeepNote")}</p> : null}
            <p className="docker-registry-storage-note"><KeyRound aria-hidden="true" size={14} />{t("workspace.management.docker.images.registryStorageNote")}</p>
            {error ? <p className="docker-image-error">{error}</p> : null}
          </form>
        ) : (
          <div className="docker-registry-list-body">
            <div className="docker-registry-list-heading">
              <p>{t("workspace.management.docker.images.registryDescription")}</p>
              <button type="button" onClick={startCreate} disabled={loading}><Plus aria-hidden="true" size={14} /><span>{t("workspace.management.docker.images.addRegistry")}</span></button>
            </div>
            {loadError ? <p className="docker-image-error">{loadError}</p> : null}
            {loading ? (
              <div className="docker-registry-loading"><LoaderCircle aria-hidden="true" size={17} />{t("workspace.management.docker.images.loadingRegistries")}</div>
            ) : registries.length ? (
              <div className="docker-registry-list">
                {registries.map((registry) => (
                  <article key={registry.id}>
                    <ShieldCheck aria-hidden="true" size={18} />
                    <div><strong>{registry.name}</strong><span>{registry.serverAddress}</span><small>{registry.username}</small></div>
                    <em>{registry.credentialConfigured ? t("workspace.management.docker.images.configured") : t("workspace.management.docker.images.notConfigured")}</em>
                    <div className="management-action-cluster">
                      <button type="button" className="management-icon-action" onClick={() => startEdit(registry)} aria-label={t("workspace.management.docker.images.editRegistry")} title={t("workspace.management.docker.images.editRegistry")}><Pencil aria-hidden="true" size={14} /></button>
                      <button type="button" className="management-icon-action is-danger" onClick={() => { setDeleteCandidate(registry); setError(null); }} aria-label={t("workspace.management.docker.images.deleteRegistry")} title={t("workspace.management.docker.images.deleteRegistry")}><Trash2 aria-hidden="true" size={14} /></button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <p className="management-empty">{t("workspace.management.docker.images.noRegistries")}</p>
            )}
          </div>
        )}

        <footer className="docker-image-dialog-footer">
          {deleteCandidate ? (
            <>
              <button type="button" onClick={() => setDeleteCandidate(null)} disabled={submitting}>{t("common.actions.cancel")}</button>
              <button type="button" className="is-danger" onClick={() => void confirmRegistryDelete()} disabled={submitting} aria-busy={submitting || undefined}>{submitting ? <LoaderCircle aria-hidden="true" size={15} /> : <Trash2 aria-hidden="true" size={15} />}<span>{t("workspace.management.docker.images.deleteRegistry")}</span></button>
            </>
          ) : editing ? (
            <>
              <button type="button" onClick={() => setEditing(null)} disabled={submitting}>{t("common.actions.cancel")}</button>
              <button type="submit" form="docker-registry-form" className="is-primary" disabled={!formValid || submitting} aria-busy={submitting || undefined}>{submitting ? <LoaderCircle aria-hidden="true" size={15} /> : <Check aria-hidden="true" size={15} />}<span>{t("workspace.management.docker.images.saveRegistry")}</span></button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => void onReload()} disabled={loading}>{t("common.actions.refresh")}</button>
              <button type="button" className="is-primary" onClick={onClose}>{t("common.actions.close")}</button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}

function formatDockerDate(value: string | null, locale: SupportedLocale, fallback: string): string {
  if (!value) return fallback;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime())
    ? fallback
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

function dockerImageUsageTranslationKey(image: DockerImageSummary):
  | "workspace.management.docker.images.usage.inUse"
  | "workspace.management.docker.images.usage.unused"
  | "workspace.management.docker.images.usage.unknown" {
  const usage = dockerImageUsage(image);
  if (usage === "in-use") return "workspace.management.docker.images.usage.inUse";
  if (usage === "unused") return "workspace.management.docker.images.usage.unused";
  return "workspace.management.docker.images.usage.unknown";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
