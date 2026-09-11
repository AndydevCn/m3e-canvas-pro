import { isProject } from "../project";
import type { Doc } from "../tokens";
import { PersistAdapter, PersistError } from "./types";

/* Saves into a folder the author picks once, so the canvas lives in a real file
 * (design.json) instead of inside the browser. Typed locally: the File System
 * Access API is still absent from the DOM library TypeScript ships with. */

type Writable = { write(data: string): Promise<void>; close(): Promise<void> };

export type FsFileHandle = {
  name: string;
  getFile(): Promise<File>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<Writable>;
};

export type FsDirHandle = {
  name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsFileHandle>;
  queryPermission(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState>;
};

declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      id?: string;
      mode?: "read" | "readwrite";
      startIn?: unknown;
    }) => Promise<FsDirHandle>;
  }
}

export const FILE_NAME = "design.json";
export const BACKUP_COUNT = 5;
/** backups are taken at most this often, so a long drag does not rewrite five files per second */
const BACKUP_INTERVAL_MS = 30_000;

export const backupName = (i: number) => `${FILE_NAME}.bak${i}`;

export const fileAccessSupported = () => typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";

/* ---------- the remembered folder ---------- */

const DB_NAME = "m3e-persist";
const STORE = "handles";
const KEY = "dir";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb<T>(fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, "readwrite").objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

const rememberDir = (dir: FsDirHandle) => idb((s) => s.put(dir, KEY) as IDBRequest<IDBValidKey>).then(() => undefined);
const recallDir = () =>
  idb<FsDirHandle | undefined>((s) => s.get(KEY) as IDBRequest<FsDirHandle | undefined>).catch(() => undefined);
export const forgetDir = () => idb((s) => s.delete(KEY) as IDBRequest<undefined>).then(() => undefined).catch(() => undefined);

/* ---------- writing ---------- */

async function writeText(file: FsFileHandle, text: string): Promise<void> {
  /* createWritable writes to a swap file and only then replaces the target, so a
     crash mid-write leaves the previous content intact. */
  const w = await file.createWritable();
  try {
    await w.write(text);
  } finally {
    await w.close();
  }
}

async function readText(file: FsFileHandle): Promise<string | null> {
  try {
    return await (await file.getFile()).text();
  } catch {
    return null;
  }
}

function parseDoc(text: string | null): Doc | null {
  if (!text || !text.trim()) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isProject(value) ? value : null;
  } catch {
    return null;
  }
}

/* ---------- the adapter ---------- */

export class FileAdapter implements PersistAdapter {
  readonly target = "file" as const;
  readonly label = FILE_NAME;
  private lastBackup = 0;
  /** one file per project, so several designs can mirror into the same folder */
  private fileName = FILE_NAME;

  constructor(private dir: FsDirHandle) {}

  /** safe to write on disk: letters, digits, spaces, dashes and CJK are kept */
  setName(name: string): void {
    const base = name.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || FILE_NAME;
    this.fileName = base.toLowerCase().endsWith(".json") ? base : `${base}.json`;
  }

  get name(): string {
    return this.fileName;
  }

  /** true when the browser wants the author to click before we may write again */
  needsGrant(): boolean {
    return this.permission !== "granted";
  }

  private permission: PermissionState = "granted";

  /** refresh the remembered permission; call at start-up, before the first save */
  async refreshPermission(): Promise<PermissionState> {
    try {
      this.permission = await this.dir.queryPermission({ mode: "readwrite" });
    } catch {
      this.permission = "prompt";
    }
    return this.permission;
  }

  /** must run from a user gesture (a click on "restore autosave") */
  async requestGrant(): Promise<boolean> {
    try {
      this.permission = await this.dir.requestPermission({ mode: "readwrite" });
    } catch {
      return false;
    }
    return this.permission === "granted";
  }

  async save(doc: Doc): Promise<void> {
    if (this.permission !== "granted") {
      this.permission = await this.dir.queryPermission({ mode: "readwrite" });
      if (this.permission !== "granted") throw new PersistError("permission");
    }
    try {
      const main = await this.dir.getFileHandle(this.fileName, { create: true });
      await this.rotateBackups();
      await writeText(main, JSON.stringify(doc));
    } catch (e) {
      if (e instanceof PersistError) throw e;
      throw new PersistError("write");
    }
  }

  /** the newest file that still parses: the document first, then its backups */
  async load(): Promise<Doc | null> {
    if (this.permission !== "granted") return null;
    try {
      const main = await this.dir.getFileHandle(this.fileName, { create: false });
      const doc = parseDoc(await readText(main));
      if (doc) return doc;
    } catch {
      /* no file yet: fall through to the backups */
    }
    for (let i = 1; i <= BACKUP_COUNT; i++) {
      try {
        const file = await this.dir.getFileHandle(backupName(i), { create: false });
        const doc = parseDoc(await readText(file));
        if (doc) return doc;
      } catch {
        /* keep looking */
      }
    }
    return null;
  }

  /** keep the last five versions: bak4 becomes bak5, … the current file becomes bak1 */
  private async rotateBackups(): Promise<void> {
    const now = Date.now();
    if (now - this.lastBackup < BACKUP_INTERVAL_MS) return;
    this.lastBackup = now;
    try {
      for (let i = BACKUP_COUNT; i >= 2; i--) {
        let src: FsFileHandle;
        try {
          src = await this.dir.getFileHandle(backupName(i - 1), { create: false });
        } catch {
          continue;
        }
        const text = await readText(src);
        if (text === null) continue;
        await writeText(await this.dir.getFileHandle(backupName(i), { create: true }), text);
      }
      const main = await this.dir.getFileHandle(this.fileName, { create: false });
      const text = await readText(main);
      if (text && text.trim()) await writeText(await this.dir.getFileHandle(backupName(1), { create: true }), text);
    } catch {
      /* a backup is a courtesy: never let it stop the save itself */
    }
  }
}

/* ---------- entry points ---------- */

/** the folder remembered from a previous session, or null when there is none */
export async function restoreFileAdapter(): Promise<{ adapter: FileAdapter; granted: boolean } | null> {
  if (!fileAccessSupported()) return null;
  const dir = await recallDir();
  if (!dir) return null;
  const adapter = new FileAdapter(dir);
  const permission = await adapter.refreshPermission();
  return { adapter, granted: permission === "granted" };
}

/** asks the author for the folder to keep design.json in; null when they cancel */
export async function pickFolder(): Promise<FileAdapter | null> {
  if (!fileAccessSupported()) return null;
  try {
    const dir = await window.showDirectoryPicker!({ id: "m3e-canvas", mode: "readwrite" });
    await rememberDir(dir);
    const adapter = new FileAdapter(dir);
    await adapter.refreshPermission();
    return adapter;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return null;
    throw new PersistError("write");
  }
}
