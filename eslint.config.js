import js from "@eslint/js";
import tseslint from "typescript-eslint";

const modalPortalRestriction = {
  selector: "JSXOpeningElement[name.name=/^(div|section|form)$/] > JSXAttribute[name.name='className'][value.value=/backdrop/][value.value!='notification-drawer-backdrop']",
  message: "Modal backdrops must use ModalPortal so dialogs center in the full viewport. See docs/src/content/docs/reference/frontend-design.md."
};
const filterDropdownRestriction = {
  selector: "JSXOpeningElement[name.name='select'], JSXSelfClosingElement[name.name='select']",
  message: "Dropdowns must use the shared CustomSelect, including forms, filters and nested dialogs. See docs/src/content/docs/reference/frontend-design.md."
};
const nativeTooltipRestriction = {
  selector: "JSXOpeningElement[name.name=/^[a-z]/][name.name!=iframe] > JSXAttribute[name.name=title]",
  message: "Hover hints must use data-tooltip or HelpTip with the shared HUD tooltip layer, not native title tooltips. Preserve iframe accessible titles. See docs/src/content/docs/reference/frontend-design.md."
};

export default tseslint.config(
  {
    ignores: ["**/dist/**", "node_modules/**", "coverage/**", ".*os/**", "**/.astro/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          "argsIgnorePattern": "^_",
          "varsIgnorePattern": "^_"
        }
      ]
    }
  },
  {
    files: ["packages/web/src/**/*.tsx"],
    rules: {
      "no-restricted-syntax": ["error", modalPortalRestriction, filterDropdownRestriction, nativeTooltipRestriction]
    }
  }
);
