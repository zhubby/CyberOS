import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "@fontsource-variable/noto-sans-sc/wght.css";
import "@fontsource/rajdhani/400.css";
import "@fontsource/rajdhani/500.css";
import "@fontsource/rajdhani/600.css";
import "@fontsource/rajdhani/700.css";
import { App } from "./App.js";
import { initI18n } from "./i18n/index.js";
import "./styles.css";

const bootScreen = document.getElementById("cyberos-boot");
const bootTitle = bootScreen?.querySelector<HTMLElement>("[data-boot-title]");
const bootDetail = bootScreen?.querySelector<HTMLElement>("[data-boot-detail]");
const bootSystem = bootScreen?.querySelector<HTMLElement>("[data-boot-system]");
const isChinese = document.documentElement.lang.toLowerCase().startsWith("zh");

if (isChinese) {
  if (bootTitle) {
    bootTitle.textContent = "正在准备工作区";
  }
  if (bootDetail) {
    bootDetail.textContent = "正在连接本地服务";
  }
  if (bootSystem) {
    bootSystem.textContent = "本地系统";
  }
}

function dismissBootScreen(): void {
  if (!bootScreen) {
    return;
  }
  bootScreen.setAttribute("aria-busy", "false");
  bootScreen.classList.add("is-exiting");
  window.setTimeout(() => bootScreen.remove(), 420);
}

function showBootError(): void {
  if (!bootScreen) {
    return;
  }
  bootScreen.dataset.state = "error";
  bootScreen.setAttribute("aria-busy", "false");
  if (bootTitle) {
    bootTitle.textContent = isChinese ? "CyberOS 启动失败" : "CyberOS could not start";
  }
  if (bootDetail) {
    bootDetail.textContent = isChinese ? "请重新加载页面后再试" : "Reload the page to try again";
  }
}

void initI18n()
  .then(() => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <App />
      </StrictMode>
    );
    window.dispatchEvent(new Event("cyberos:ready"));
    window.requestAnimationFrame(() => dismissBootScreen());
  })
  .catch(() => showBootError());
