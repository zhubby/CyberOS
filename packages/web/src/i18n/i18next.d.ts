import "i18next";
import { en } from "./resources.js";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: {
      translation: typeof en;
    };
    returnNull: false;
    strictKeyChecks: true;
  }
}
