import { opfsReadIndex, opfsWriteIndex } from "./opfs";

/* Several designs can live side by side. Each is a file in the private disk area;
 * this is the list that names them, remembers which one was open last, and keeps
 * the newest at the top. The list itself is pure data so it can be tested without
 * a browser. */

export type ProjectMeta = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

export type ProjectIndex = {
  version: 1;
  /** the project to open at start-up */
  lastId?: string;
  projects: ProjectMeta[];
};

export const newProjectId = () => `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

export const emptyIndex = (): ProjectIndex => ({ version: 1, projects: [] });

/* ---------- pure helpers ---------- */

export const sortedProjects = (ix: ProjectIndex): ProjectMeta[] =>
  [...ix.projects].sort((a, b) => b.updatedAt - a.updatedAt);

/** add or replace one entry, keeping every other one where it was */
export function withProject(ix: ProjectIndex, meta: ProjectMeta): ProjectIndex {
  const exists = ix.projects.some((p) => p.id === meta.id);
  return {
    ...ix,
    projects: exists ? ix.projects.map((p) => (p.id === meta.id ? meta : p)) : [meta, ...ix.projects],
  };
}

export function withoutProject(ix: ProjectIndex, id: string): ProjectIndex {
  return { ...ix, projects: ix.projects.filter((p) => p.id !== id), lastId: ix.lastId === id ? undefined : ix.lastId };
}

export function renamedProject(ix: ProjectIndex, id: string, name: string, at = Date.now()): ProjectIndex {
  return withProject(ix, { ...ix.projects.find((p) => p.id === id)!, name, updatedAt: at });
}

/** mark a project as the one being edited: it moves to the top of the list */
export function openedProject(ix: ProjectIndex, id: string, at = Date.now()): ProjectIndex {
  const found = ix.projects.find((p) => p.id === id);
  if (!found) return { ...ix, lastId: id };
  return { ...withProject(ix, { ...found, updatedAt: at }), lastId: id };
}

export function newProject(name: string, at = Date.now()): ProjectMeta {
  return { id: newProjectId(), name, createdAt: at, updatedAt: at };
}

/* ---------- reading and writing the list ---------- */

function parseIndex(text: string | null): ProjectIndex {
  if (!text || !text.trim()) return emptyIndex();
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object") return emptyIndex();
    const raw = value as Partial<ProjectIndex>;
    const projects = Array.isArray(raw.projects)
      ? raw.projects.filter(
          (p): p is ProjectMeta =>
            !!p && typeof p.id === "string" && typeof p.name === "string" && Number.isFinite(p.updatedAt),
        )
      : [];
    return { version: 1, lastId: typeof raw.lastId === "string" ? raw.lastId : undefined, projects };
  } catch {
    /* a damaged list must not lose the designs it pointed at: start over */
    return emptyIndex();
  }
}

export async function loadIndex(): Promise<ProjectIndex> {
  return parseIndex(await opfsReadIndex());
}

export async function saveIndex(ix: ProjectIndex): Promise<void> {
  await opfsWriteIndex(JSON.stringify(ix));
}
