export function normalizeCyberAudioBaseUrl(value: unknown): string | null {
  if (value === null) return null;
  const invalid = () => new Error("CyberAudio requires an HTTP/HTTPS service address without credentials, query parameters, or a fragment");
  if (typeof value !== "string") throw invalid();
  const address = value.trim();
  if (!address) return null;
  if (
    address.length > 2048
    || /[\s\\]/u.test(address)
    || Array.from(address).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) throw invalid();

  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw invalid();
  }
  if (
    !/^https?:\/\//iu.test(address)
    || !["http:", "https:"].includes(url.protocol)
    || !url.hostname
    || url.username
    || url.password
    || address.includes("?")
    || address.includes("#")
  ) throw invalid();
  const normalized = url.toString().replace(/\/+$/u, "");
  if (normalized.length > 2048) throw invalid();
  return normalized;
}
