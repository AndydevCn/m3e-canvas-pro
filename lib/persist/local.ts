import { isProject } from "../project";
import type { Doc } from "../tokens";
import { PersistAdapter, PersistError } from "./types";

/** the same key the editor has always used, so an existing canvas is picked up */
export const DOC_KEY = "m3e:doc";

/** localStorage carries around 5MB; a few images are enough to overflow it, and
 *  the browser reports that as a quota error rather than a write error. */
function isQuotaError(e: unknown): boolean {
  return (
    e instanceof DOMException &&
    (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED" || e.code === 22)
  );
}

/** the fallback store: invisible, per-origin, and lost with the browser profile */
export class LocalAdapter implements PersistAdapter {
  readonly target = "local" as const;
  readonly label = "browser";

  async save(doc: Doc): Promise<void> {
    try {
      localStorage.setItem(DOC_KEY, JSON.stringify(doc));
    } catch (e) {
      /* the original code swallowed this; a full localStorage silently stops
         saving, which is exactly how a canvas goes missing. */
      throw new PersistError(isQuotaError(e) ? "quota" : "write");
    }
  }

  async load(): Promise<Doc | null> {
    try {
      const raw = localStorage.getItem(DOC_KEY);
      if (!raw) return null;
      const value: unknown = JSON.parse(raw);
      return isProject(value) ? value : null;
    } catch {
      return null;
    }
  }

  needsGrant() {
    return false;
  }

  async requestGrant() {
    return true;
  }
}
