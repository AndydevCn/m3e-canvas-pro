import { isProject } from "../project";
import type { Doc } from "../tokens";

/* The browser's own private disk area (Origin Private File System).
 *
 * Unlike localStorage it holds a whole design with its images, it is not limited
 * to a few megabytes, and no permission prompt is ever shown. The files are not
 * visible in Explorer — that is what "Export project" is for — but they survive
 * closing the tab, restarting the browser and rebooting the machine.
 *
 * The API is still missing from the DOM library TypeScript ships with, so the
 * few shapes we use are declared here. */

type Writable = { write(data: string | Blob): Promise<void>; close(): Promise<void> };

export type OpfsFileHandle = {
  name: string;
  getFile(): Promise<File>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<Writable>;
};

export type OpfsDirHandle = {
  name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
};

type StorageWithOpfs = { getDirectory(): Promise<OpfsDirHandle> };

export const opfsSupported = () =>
  typeof navigator !== "undefined" &&
  typeof (navigator.storage as unknown as Partial<StorageWithOpfs> | undefined)?.getDirectory === "function";

/** one directory per origin: m3e-canvas/projects */
const APP_DIR = "m3e-canvas";
const PROJECTS_DIR = "projects";
const INDEX_FILE = "index.json";

let dirPromise: Promise<OpfsDirHandle> | null = null;

async function projects(): Promise<OpfsDirHandle> {
  if (!dirPromise) {
    dirPromise = (async () => {
      const root = await (navigator.storage as unknown as StorageWithOpfs).getDirectory();
      const app = await root.getDirectoryHandle(APP_DIR, { create: true });
      return await app.getDirectoryHandle(PROJECTS_DIR, { create: true });
    })();
  }
  return dirPromise;
}

export const BACKUP_COUNT = 5;
/** a long drag must not rewrite five files a second */
const BACKUP_INTERVAL_MS = 30_000;
const lastBackupAt = new Map<string, number>();

export const projectFile = (id: string) => `${id}.json`;
export const backupFile = (id: string, i: number) => `${id}.json.bak${i}`;
export const thumbFile = (id: string) => `${id}.thumb`;

async function writeText(name: string, text: string): Promise<void> {
  const dir = await projects();
  /* createWritable writes to a swap file and only then replaces the target, so a
     crash in the middle leaves the previous content intact. */
  const file = await dir.getFileHandle(name, { create: true });
  const w = await file.createWritable();
  try {
    await w.write(text);
  } finally {
    await w.close();
  }
}

async function readText(name: string): Promise<string | null> {
  try {
    const dir = await projects();
    const file = await dir.getFileHandle(name, { create: false });
    return await (await file.getFile()).text();
  } catch {
    return null;
  }
}

async function drop(name: string): Promise<void> {
  try {
    const dir = await projects();
    await dir.removeEntry(name);
  } catch {
    /* already gone */
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

/* ---------- documents ---------- */

/** bak4 becomes bak5, … the current file becomes bak1, then the new content lands */
async function rotateBackups(id: string): Promise<void> {
  const now = Date.now();
  if (now - (lastBackupAt.get(id) ?? 0) < BACKUP_INTERVAL_MS) return;
  lastBackupAt.set(id, now);
  try {
    for (let i = BACKUP_COUNT; i >= 2; i--) {
      const text = await readText(backupFile(id, i - 1));
      if (text === null) continue;
      await writeText(backupFile(id, i), text);
    }
    const current = await readText(projectFile(id));
    if (current && current.trim()) await writeText(backupFile(id, 1), current);
  } catch {
    /* a backup is a courtesy: never let it stop the save itself */
  }
}

export async function opfsSaveProject(id: string, doc: Doc): Promise<void> {
  await rotateBackups(id);
  await writeText(projectFile(id), JSON.stringify(doc));
}

/** the newest copy that still parses: the document first, then its backups */
export async function opfsLoadProject(id: string): Promise<Doc | null> {
  const main = parseDoc(await readText(projectFile(id)));
  if (main) return main;
  for (let i = 1; i <= BACKUP_COUNT; i++) {
    const backup = parseDoc(await readText(backupFile(id, i)));
    if (backup) return backup;
  }
  return null;
}

export async function opfsDeleteProject(id: string): Promise<void> {
  await drop(projectFile(id));
  for (let i = 1; i <= BACKUP_COUNT; i++) await drop(backupFile(id, i));
  await drop(thumbFile(id));
}

/* ---------- thumbnails ---------- */

/** stored as the data URL itself: one small file, no object URLs to revoke */
export async function opfsWriteThumb(id: string, dataUrl: string): Promise<void> {
  await writeText(thumbFile(id), dataUrl);
}

export async function opfsReadThumb(id: string): Promise<string | null> {
  const text = await readText(thumbFile(id));
  return text && text.startsWith("data:image/") ? text : null;
}

/* ---------- the project list ---------- */

export async function opfsReadIndex(): Promise<string | null> {
  return await readText(INDEX_FILE);
}

export async function opfsWriteIndex(text: string): Promise<void> {
  await writeText(INDEX_FILE, text);
}
