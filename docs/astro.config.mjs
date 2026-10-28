import { defineConfig } from "astro/config";
import mermaid from "astro-mermaid";
import starlight from "@astrojs/starlight";
import starlightLinksValidator from "starlight-links-validator";

export default defineConfig({
  output: "static",
  base: "/docs",
  site: globalThis.process?.env.ZOS_DOCS_SITE ?? "http://127.0.0.1:3010",
  integrations: [
    mermaid(),
    starlight({
      title: "ZOS",
      description: "ZOS Linux NAS appliance 的技术实现、架构与运维文档。",
      customCss: ["./src/styles/custom.css"],
      components: {
        ThemeProvider: "./src/components/FixedThemeProvider.astro",
        ThemeSelect: "./src/components/NoThemeSelect.astro"
      },
      logo: {
        src: "./src/assets/zos-icon.svg",
        alt: ""
      },
      locales: {
        root: { label: "简体中文", lang: "zh-CN" }
      },
      sidebar: [
        { label: "开始使用", items: [{ autogenerate: { directory: "start" } }] },
        { label: "教程与操作", items: [{ autogenerate: { directory: "how-to" } }] },
        { label: "架构与设计", items: [{ autogenerate: { directory: "architecture" } }] },
        { label: "组件", items: [{ autogenerate: { directory: "components" } }] },
        { label: "运维", items: [{ autogenerate: { directory: "operations" } }] },
        { label: "参考", items: [{ autogenerate: { directory: "reference" } }] }
      ],
      plugins: [starlightLinksValidator()]
    })
  ]
});
