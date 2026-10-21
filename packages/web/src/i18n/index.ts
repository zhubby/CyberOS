import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { DEFAULT_LOCALE, resolveInitialLocale, resolveSupportedLocale } from "./locale.js";
import { resources } from "./resources.js";

let documentLanguageListenerRegistered = false;

export async function initI18n(): Promise<typeof i18n> {
  if (!i18n.isInitialized) {
    await i18n.use(initReactI18next).init({
      resources,
      lng: resolveInitialLocale(),
      fallbackLng: DEFAULT_LOCALE,
      supportedLngs: ["en", "zh-CN"],
      defaultNS: "translation",
      interpolation: {
        escapeValue: false
      },
      react: {
        useSuspense: false
      },
      returnNull: false
    });
  }

  syncDocumentLanguage(i18n.resolvedLanguage ?? i18n.language);
  if (!documentLanguageListenerRegistered) {
    i18n.on("languageChanged", syncDocumentLanguage);
    documentLanguageListenerRegistered = true;
  }
  return i18n;
}

function syncDocumentLanguage(language: string): void {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.lang = resolveSupportedLocale(language);
}

export { i18n };
