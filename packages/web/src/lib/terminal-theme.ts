import type { ITheme, Terminal } from "@xterm/xterm";

const FALLBACK_FONT_FAMILY = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace";
const FALLBACK_FONT_SIZE = 12;

export function terminalOptions(element: HTMLElement): {
  fontFamily: string;
  fontSize: number;
  theme: ITheme;
} {
  const styles = getComputedStyle(element);
  const fontSize = Number.parseFloat(styles.getPropertyValue("--code-font-size"));

  return {
    fontFamily: cssValue(styles, "--code-font-family", FALLBACK_FONT_FAMILY),
    fontSize: Number.isFinite(fontSize) ? fontSize : FALLBACK_FONT_SIZE,
    theme: terminalTheme(styles)
  };
}

export function applyTerminalOptions(terminal: Terminal, element: HTMLElement): void {
  const options = terminalOptions(element);
  terminal.options.fontFamily = options.fontFamily;
  terminal.options.fontSize = options.fontSize;
  terminal.options.theme = options.theme;
}

function terminalTheme(styles: CSSStyleDeclaration): ITheme {
  return {
    background: cssValue(styles, "--code-bg", "#171922"),
    foreground: cssValue(styles, "--code-text", "#f2f5f8"),
    cursor: cssValue(styles, "--accent", "#5865f2"),
    cursorAccent: cssValue(styles, "--code-bg", "#171922"),
    selectionBackground: cssValue(styles, "--selection-bg", "rgb(88 101 242 / 36%)"),
    black: cssValue(styles, "--app-bg", "#0f1015"),
    brightBlack: cssValue(styles, "--muted-2", "#858b98"),
    red: cssValue(styles, "--danger-strong-text", "#ff8a8e"),
    brightRed: cssValue(styles, "--danger-text", "#ffb3b6"),
    green: cssValue(styles, "--success-text", "#78d89d"),
    brightGreen: cssValue(styles, "--success-text", "#78d89d"),
    yellow: cssValue(styles, "--warning-text", "#ffd37a"),
    brightYellow: cssValue(styles, "--warning-text", "#ffd37a"),
    blue: cssValue(styles, "--link", "#8ea1ff"),
    brightBlue: cssValue(styles, "--accent", "#5865f2"),
    magenta: cssValue(styles, "--syntax-regexp", "#cfa8ff"),
    brightMagenta: cssValue(styles, "--syntax-regexp", "#cfa8ff"),
    cyan: cssValue(styles, "--syntax-type", "#6ed3f5"),
    brightCyan: cssValue(styles, "--teal-text", "#78d8c8"),
    white: cssValue(styles, "--muted", "#b5bac1"),
    brightWhite: cssValue(styles, "--code-text", "#f2f5f8")
  };
}

function cssValue(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  return styles.getPropertyValue(name).trim() || fallback;
}
