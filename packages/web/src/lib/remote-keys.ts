export function isBackKey(event: { key: string; keyCode?: number }): boolean {
  return ["Escape", "BrowserBack", "GoBack"].includes(event.key) || event.keyCode === 461;
}

export function isHomeKey(event: { key: string }): boolean {
  return ["BrowserHome", "Home"].includes(event.key);
}
