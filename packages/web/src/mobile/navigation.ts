import { isMobileAppId, type MobileAppId } from "./apps.js";

export type MobileRoute = "home" | MobileAppId;

export function parseMobileHash(hash: string): MobileRoute {
  const match = /^#\/app\/([A-Za-z]+)$/u.exec(hash);
  return match?.[1] && isMobileAppId(match[1]) ? match[1] : "home";
}

export function formatMobileHash(route: MobileRoute): string {
  return route === "home" ? "#/home" : `#/app/${route}`;
}

export class BackHandlerStack {
  private handlers = new Map<symbol, { handle: () => boolean; priority: number; order: number }>();
  private order = 0;

  add(handle: () => boolean, priority: number): () => void {
    const id = Symbol();
    this.handlers.set(id, { handle, priority, order: this.order++ });
    return () => { this.handlers.delete(id); };
  }

  consume(): boolean {
    for (const handler of [...this.handlers.values()].sort((a, b) => b.priority - a.priority || b.order - a.order)) {
      if (handler.handle()) return true;
    }
    return false;
  }
}

/** Lives for one mounted application; view state never leaves this tab. */
export class ViewStateStore {
  private values = new Map<string, unknown>();
  get<T>(key: string, fallback: T): T {
    return this.values.has(key) ? this.values.get(key) as T : fallback;
  }
  set<T>(key: string, value: T): void {
    this.values.set(key, value);
  }
}
