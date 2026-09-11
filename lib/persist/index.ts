import { t, type Lang } from "../i18n";
import type { Doc } from "../tokens";
import { FILE_NAME, FileAdapter, pickFolder, restoreFileAdapter } from "./fsFile";
import { LocalAdapter } from "./local";
import {
  BACKUP_COUNT,
  opfsDeleteProject,
  opfsLoadProject,
  opfsReadThumb,
  opfsSaveProject,
  opfsSupported,
  opfsWriteThumb,
} from "./opfs";
import {
  ProjectIndex,
  ProjectMeta,
  emptyIndex,
  loadIndex,
  newProject,
  openedProject,
  renamedProject,
  saveIndex,
  sortedProjects,
  withProject,
  withoutProject,
} from "./projects";
import { IDLE_STATUS, PersistAdapter, PersistError, SaveStatus } from "./types";

/** how long the canvas waits after the last edit before writing */
const DEBOUNCE_MS = 800;
/** a thumbnail is a courtesy: at most one every this many seconds */
const THUMB_INTERVAL_MS = 15_000;
/** the project list is rewritten at most this often while editing */
const INDEX_THROTTLE_MS = 5_000;

export type { SaveError, SavePhase, SaveStatus, SaveTarget } from "./types";
export type { ProjectMeta } from "./projects";
export { PersistError } from "./types";
export { fileAccessSupported, FILE_NAME } from "./fsFile";
export { BACKUP_COUNT };

/** what the toolbar needs to draw the project switcher */
export type ProjectSnapshot = {
  /** null before the store has finished looking at the disk */
  id: string | null;
  name: string;
  projects: ProjectMeta[];
};

/** Chooses where a canvas is kept, writes to it on a debounce, and reports what
 *  happened so the toolbar can show it. The editor only ever calls save().
 *
 *  The private disk area (OPFS) is the home of a design: it needs no permission,
 *  holds images, and survives everything except clearing site data. A folder the
 *  author picked is an optional extra copy; localStorage is the last resort. */
export class PersistStore {
  private adapter: PersistAdapter | null = null;
  private file: FileAdapter | null = null;
  private fileGranted = false;
  private local = new LocalAdapter();
  private timer: number | null = null;
  private pending: Doc | null = null;
  private status: SaveStatus = IDLE_STATUS;
  private listeners = new Set<(s: SaveStatus) => void>();

  private index: ProjectIndex = emptyIndex();
  private id: string | null = null;
  private name = "";
  private projectListeners = new Set<(s: ProjectSnapshot) => void>();
  private indexTimer: number | null = null;
  private lastThumbAt = 0;
  private thumbProvider: (() => Promise<string | null>) | null = null;
  /** the language new projects are named in; the editor keeps it up to date */
  private lang: Lang = "ja";

  /** names of projects the store makes on its own follow the interface language */
  setLang = (lang: Lang) => {
    this.lang = lang;
  };

  private get untitledName(): string {
    return t("untitled", this.lang);
  }

  getStatus = (): SaveStatus => this.status;

  subscribe = (fn: (s: SaveStatus) => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  subscribeProjects = (fn: (s: ProjectSnapshot) => void) => {
    this.projectListeners.add(fn);
    return () => this.projectListeners.delete(fn);
  };

  getProjects = (): ProjectSnapshot => ({ id: this.id, name: this.name, projects: sortedProjects(this.index) });

  /** the toolbar asks for a thumbnail only when the switcher is open */
  getThumb = (id: string) => (opfsSupported() ? opfsReadThumb(id) : Promise.resolve(null));

  /** supplied by the editor, which owns the DOM the picture is taken of */
  setThumbProvider = (fn: (() => Promise<string | null>) | null) => {
    this.thumbProvider = fn;
  };

  private setStatus(patch: Partial<SaveStatus>) {
    this.status = { ...this.status, ...patch };
    for (const fn of this.listeners) fn(this.status);
  }

  private emitProjects() {
    const snapshot = this.getProjects();
    for (const fn of this.projectListeners) fn(snapshot);
  }

  private statusTarget(): SaveStatus["target"] {
    if (this.file && this.fileGranted) return "file";
    return opfsSupported() && this.id ? "disk" : "local";
  }

  private statusName(): string | undefined {
    return this.file && this.fileGranted ? this.file.name : undefined;
  }

  /* ---------- start-up ---------- */

  /** Restores the remembered folder and the project that was open last.
   *  Returns a document to open, or null when the canvas should stay as it is. */
  async init(): Promise<Doc | null> {
    if (typeof window === "undefined") return null;
    const restored = await restoreFileAdapter();
    if (restored) {
      this.file = restored.adapter;
      this.fileGranted = restored.granted;
    }
    if (!opfsSupported()) {
      this.adapter = this.local;
      this.setStatus({ target: "local", phase: "idle", name: undefined });
      return await this.local.load();
    }
    this.index = await loadIndex();
    /* names written by a build that did not know the language yet */
    if (this.translateAutoNames()) await saveIndex(this.index);
    /* an edit made while the disk was being looked up must still be written */
    if (this.pending) await this.write();

    if (this.index.projects.length === 0) {
      /* the canvas this browser already had becomes the first project, so an
         existing design is not left behind in localStorage */
      const legacy = await this.local.load();
      const meta = newProject(legacy?.title?.trim() || (legacy ? t("importedDesign", this.lang) : this.untitledName));
      this.index = openedProject(withProject(this.index, meta), meta.id);
      this.id = meta.id;
      this.name = meta.name;
      this.file?.setName(meta.name);
      await saveIndex(this.index);
      this.emitProjects();
      this.setStatus({ target: this.statusTarget(), phase: "idle" });
      if (legacy) {
        await opfsSaveProject(meta.id, legacy);
        return legacy;
      }
      return null;
    }

    const wanted = this.index.lastId;
    const id =
      wanted && this.index.projects.some((p) => p.id === wanted) ? wanted : sortedProjects(this.index)[0].id;
    this.id = id;
    this.name = this.index.projects.find((p) => p.id === id)?.name ?? "";
    this.file?.setName(this.name);
    this.emitProjects();
    this.setStatus({ target: this.statusTarget(), phase: "idle", name: this.statusName() });
    if (restored && !restored.granted) this.setStatus({ phase: "error", error: "permission" });
    return await opfsLoadProject(id);
  }

  /* ---------- projects ---------- */

  /** Rename the projects this store named itself, so they read in the language
   *  the author is looking at. Hand-written names are left alone. */
  private translateAutoNames(): boolean {
    const imported = t("importedDesign", this.lang);
    let changed = false;
    for (const p of this.index.projects) {
      const next = p.name === LEGACY_NAME ? imported : p.name === FIRST_NAME ? this.untitledName : null;
      if (!next || next === p.name) continue;
      this.index = renamedProject(this.index, p.id, next);
      if (this.id === p.id) {
        this.name = next;
        this.file?.setName(next);
      }
      changed = true;
    }
    return changed;
  }

  /** switch to another design; the current one is written first */
  async openProject(id: string): Promise<Doc | null> {
    if (!this.id || id === this.id) return null;
    await this.flush();
    this.pending = null;
    this.id = id;
    this.name = this.index.projects.find((p) => p.id === id)?.name ?? "";
    this.file?.setName(this.name);
    this.touchIndex(true);
    return await opfsLoadProject(id);
  }

  /** a fresh empty design; returns its id. The editor blanks the canvas. */
  async createProject(name: string): Promise<string> {
    await this.flush();
    const meta = newProject(name.trim() || this.untitledName);
    this.index = openedProject(withProject(this.index, meta), meta.id);
    this.id = meta.id;
    this.name = meta.name;
    this.pending = null;
    this.file?.setName(meta.name);
    await saveIndex(this.index);
    this.emitProjects();
    this.setStatus({ target: this.statusTarget(), phase: "idle", name: this.statusName(), error: undefined });
    return meta.id;
  }

  async renameProject(name: string): Promise<void> {
    if (!this.id) return;
    const clean = name.trim() || this.untitledName;
    this.index = renamedProject(this.index, this.id, clean);
    this.name = clean;
    this.file?.setName(clean);
    await saveIndex(this.index);
    this.emitProjects();
  }

  async deleteProject(id: string): Promise<void> {
    if (this.id === id) this.pending = null;
    await opfsDeleteProject(id);
    this.index = withoutProject(this.index, id);
    await saveIndex(this.index);
    this.emitProjects();
  }

  /* ---------- optional file copy ---------- */

  /** asks for the folder and starts saving into <project>.json; false when cancelled */
  async linkFolder(): Promise<boolean> {
    if (typeof window === "undefined") return false;
    const adapter = await pickFolder();
    if (!adapter) return false;
    this.file = adapter;
    adapter.setName(this.name);
    this.fileGranted = !adapter.needsGrant();
    this.setStatus({ target: this.statusTarget(), name: this.statusName(), phase: "idle", error: undefined });
    if (this.pending) await this.write();
    return true;
  }

  /** resume writing after the browser dropped the permission */
  async requestGrant(): Promise<boolean> {
    if (!(this.file instanceof FileAdapter)) return true;
    const ok = await this.file.requestGrant();
    this.fileGranted = ok;
    this.setStatus(
      ok
        ? { target: this.statusTarget(), name: this.statusName(), phase: "idle", error: undefined }
        : { phase: "error", error: "permission" },
    );
    if (ok && this.pending) await this.write();
    return ok;
  }

  /* ---------- writing ---------- */

  save(doc: Doc) {
    this.pending = doc;
    this.setStatus({ phase: "pending" });
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.write();
    }, DEBOUNCE_MS);
  }

  /** write now, without waiting for the debounce (closing the tab, switching away) */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    await this.write();
  }

  private async write(): Promise<void> {
    const doc = this.pending;
    if (!doc) return;
    const onDisk = opfsSupported() && !!this.id;
    try {
      if (onDisk) {
        await opfsSaveProject(this.id as string, doc);
        await this.writeThumb(this.id as string);
        this.touchIndex(false);
      } else {
        await this.local.save(doc);
      }
      /* the folder copy is an extra: it must never fail the save */
      if (this.file && this.fileGranted) {
        try {
          await this.file.save(doc);
        } catch {
          this.fileGranted = false;
        }
      }
      this.pending = null;
      this.setStatus({
        phase: "saved",
        target: this.statusTarget(),
        name: this.statusName(),
        at: Date.now(),
        error: undefined,
      });
    } catch (e) {
      const reason = e instanceof PersistError ? e.reason : "write";
      /* the private disk refused: try the browser before giving up */
      if (onDisk) {
        try {
          await this.local.save(doc);
        } catch {
          /* both ways are closed: the error below is what the author sees */
        }
      }
      this.setStatus({ phase: "error", target: this.statusTarget(), error: reason });
    }
  }

  private async writeThumb(id: string): Promise<void> {
    if (!this.thumbProvider) return;
    const now = Date.now();
    if (now - this.lastThumbAt < THUMB_INTERVAL_MS) return;
    this.lastThumbAt = now;
    try {
      const url = await this.thumbProvider();
      if (url) await opfsWriteThumb(id, url);
    } catch {
      /* a missing picture costs nothing but the picture */
    }
  }

  private touchIndex(now: boolean) {
    if (!this.id) return;
    this.index = openedProject(this.index, this.id);
    this.emitProjects();
    if (now) {
      void saveIndex(this.index);
      return;
    }
    if (this.indexTimer !== null) return;
    this.indexTimer = window.setTimeout(() => {
      this.indexTimer = null;
      void saveIndex(this.index);
    }, INDEX_THROTTLE_MS);
  }

  /** flush when the tab goes away; returns a detach function */
  attach(): () => void {
    if (typeof window === "undefined") return () => undefined;
    const onHide = () => void this.flush();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void this.flush();
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }
}

/** the name a canvas already in this browser is imported under, as an older build wrote it */
const LEGACY_NAME = "Imported design";
/** the first project of a fresh browser, likewise */
const FIRST_NAME = "Untitled";
