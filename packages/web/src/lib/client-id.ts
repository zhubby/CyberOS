interface ClientCrypto {
  randomUUID?: () => string;
  getRandomValues?: (values: Uint8Array) => Uint8Array;
}

export function createClientId(cryptoSource: ClientCrypto | undefined = browserCrypto()): string {
  try {
    if (typeof cryptoSource?.randomUUID === "function") {
      return cryptoSource.randomUUID();
    }
  } catch {
    // Embedded and non-secure browser contexts may expose but reject randomUUID.
  }

  const bytes = new Uint8Array(16);
  try {
    if (typeof cryptoSource?.getRandomValues === "function") {
      cryptoSource.getRandomValues(bytes);
    } else {
      fillWithMathRandom(bytes);
    }
  } catch {
    fillWithMathRandom(bytes);
  }

  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function browserCrypto(): ClientCrypto | undefined {
  return typeof globalThis.crypto === "undefined" ? undefined : globalThis.crypto;
}

function fillWithMathRandom(bytes: Uint8Array): void {
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
}
