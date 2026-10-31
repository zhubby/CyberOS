import js from "@eslint/js";
import tseslint from "typescript-eslint";

const modalPortalRestriction = {
  selector: "JSXOpeningElement[name.name=/^(div|section|form)$/] > JSXAttribute[name.name='className'][value.value=/backdrop/][value.value!='notification-drawer-backdrop']",
  message: "Modal backdrops must use ModalPortal so dialogs center in the full viewport. See docs/src/content/docs/reference/frontend-design.md."
};
const filterDropdownRestriction = {
  selector: "JSXElement:has(> JSXOpeningElement[name.name='SearchFilterPopover']) JSXOpeningElement[name.name='select']",
  message: "Search filter dropdowns must use CustomSelect. See docs/src/content/docs/reference/frontend-design.md."
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
    files: ["packages/web/src/components/**/*.tsx"],
    rules: {
      "no-restricted-syntax": ["error", modalPortalRestriction, filterDropdownRestriction]
    }
  },
  {
    files: [
      "packages/web/src/components/settings/**/*.tsx",
      "packages/web/src/components/workspace/SystemWifiManagement.tsx"
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        modalPortalRestriction,
        filterDropdownRestriction,
        {
          selector: "JSXOpeningElement[name.name='select']",
          message: "Settings dropdowns must use CustomSelect, including nested dialogs and shared settings controls. See docs/src/content/docs/reference/frontend-design.md."
        }
      ]
    }
  }
);
