import type { Doc } from "../tokens";

/* Persistence for a canvas that runs from a folder on the author's own machine.
 *
 * The app has no backend, so a document can only live in the browser (localStorage)
 * or in a file the author picks once through the File System Access API. Both are
 * wrapped in the same adapter so the editor never has to know which one is in play.
 */

/** where the autosave writes: a file the author picked, the browser's own disk
 *  area (OPFS), localStorage as a last resort, or nowhere yet */
export type SaveTarget = "file" | "disk" | "local" | "none";

/** the state of the last write, shown by the toolbar chip */
export type SavePhase = "idle" | "pending" | "saved" | "error";

/** why a write failed; the toolbar and the toast both read it */
export type SaveError = "quota" | "permission" | "write";

export type SaveStatus = {
  target: SaveTarget;
  phase: SavePhase;
  /** "design.json" when target is "file" */
  name?: string;
  /** ms epoch of the last successful write */
  at?: number;
  /** set when phase is "error" */
  error?: SaveError;
};

/** thrown by an adapter when a write could not land */
export class PersistError extends Error {
  constructor(readonly reason: SaveError, message?: string) {
    super(message ?? reason);
    this.name = "PersistError";
  }
}

export interface PersistAdapter {
  readonly target: "file" | "local";
  /** what to show in the chip: the file name, or "browser" */
  readonly label: string;
  save(doc: Doc): Promise<void>;
  load(): Promise<Doc | null>;
  /** true when writing can only resume after the author acts (re-grants the file) */
  needsGrant(): boolean;
  /** asks again for the file permission; must be called from a user gesture */
  requestGrant(): Promise<boolean>;
}

export const IDLE_STATUS: SaveStatus = { target: "none", phase: "idle" };
