import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/newsreader/wght.css";
import "@fontsource-variable/noto-sans-sc/wght.css";
import "@fontsource-variable/noto-serif-sc/wght.css";
import "pinyin-ime";
import "pinyin-ime/pinyin-ime.css";
import { initI18n } from "../i18n/index.js";
import { TvApp } from "./TvApp.js";
import "./tv.css";

void initI18n().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <TvApp />
    </StrictMode>
  );
});
