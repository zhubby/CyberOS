import type {
  DockerComposeAppDetail,
  DockerComposeEnvironmentCreateInput,
  DockerComposeEnvironmentUpdateInput,
  DockerComposeServiceHostAccess
} from "@zos/shared";

export interface DockerComposeEnvironmentFormRow {
  key: string;
  value: string;
  valueConfigured: boolean;
  originalKey: string | null;
  valueChanged: boolean;
}

export interface DockerComposeAppForm {
  name: string;
  projectKey: string;
  composeContent: string;
  environment: DockerComposeEnvironmentFormRow[];
  hostAccess: DockerComposeServiceHostAccess[];
}

const PROJECT_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const RESERVED_ENVIRONMENT_KEY_PATTERN = /^(?:COMPOSE_|DOCKER_)/u;

export function initialDockerComposeAppForm(): DockerComposeAppForm {
  return {
    name: "",
    projectKey: "",
    composeContent: "services:\n  app:\n    image: \n",
    environment: [],
    hostAccess: []
  };
}

export function dockerComposeAppForm(detail: DockerComposeAppDetail): DockerComposeAppForm {
  return {
    name: detail.name,
    projectKey: detail.projectKey,
    composeContent: detail.composeContent,
    environment: detail.environment.map((entry) => ({
      key: entry.key,
      value: "",
      valueConfigured: entry.valueConfigured,
      originalKey: entry.key,
      valueChanged: false
    })),
    hostAccess: (detail.hostAccess ?? []).map((entry) => ({ service: entry.service, grants: entry.grants.map((grant) => ({ ...grant })) }))
  };
}

export function dockerComposeProjectKey(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 63);
  return normalized && /^[a-z0-9]/u.test(normalized) ? normalized : "app";
}

export function dockerComposeAppFormError(form: DockerComposeAppForm): string | null {
  if (!form.name.trim()) return "name";
  if (!PROJECT_KEY_PATTERN.test(form.projectKey.trim())) return "projectKey";
  if (!form.composeContent.trim()) return "composeContent";
  if (byteLength(form.composeContent) > 256 * 1024) return "composeTooLarge";
  if (form.environment.length > 256) return "environmentTooLarge";
  const keys = new Set<string>();
  let environmentBytes = 0;
  for (const entry of form.environment) {
    const key = entry.key.trim();
    if (!ENVIRONMENT_KEY_PATTERN.test(key) || RESERVED_ENVIRONMENT_KEY_PATTERN.test(key)) return "environmentKey";
    if (byteLength(key) > 128) return "environmentKey";
    if (keys.has(key)) return "environmentDuplicate";
    keys.add(key);
    if (entry.value.includes("\0")) return "environmentValue";
    if (entry.valueConfigured && entry.originalKey !== key && !entry.valueChanged) return "environmentValue";
    environmentBytes += byteLength(key) + byteLength(entry.value);
  }
  return environmentBytes > 256 * 1024 ? "environmentTooLarge" : null;
}

export function dockerComposeCreateEnvironment(
  rows: DockerComposeEnvironmentFormRow[]
): DockerComposeEnvironmentCreateInput[] {
  return rows.map((entry) => ({ key: entry.key.trim(), value: entry.value }));
}

export function dockerComposeUpdateEnvironment(
  rows: DockerComposeEnvironmentFormRow[]
): DockerComposeEnvironmentUpdateInput[] {
  return rows.map((entry) => ({
    key: entry.key.trim(),
    ...(entry.valueConfigured && !entry.valueChanged && entry.originalKey === entry.key.trim()
      ? {}
      : { value: entry.value })
  }));
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
