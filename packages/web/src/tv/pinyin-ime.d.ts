import type React from "react";

export type PinyinImeElement = HTMLElement & {
  value: string;
  enabled: boolean;
  focus(): void;
};

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "pinyin-ime-editor": React.DetailedHTMLProps<React.HTMLAttributes<PinyinImeElement>, PinyinImeElement> & {
        value?: string;
        enabled?: boolean | string;
        placeholder?: string;
        "editor-type"?: "input" | "textarea";
        "page-size"?: number | string;
        "popup-position"?: "top" | "bottom" | "left" | "right";
      };
    }
  }
}
