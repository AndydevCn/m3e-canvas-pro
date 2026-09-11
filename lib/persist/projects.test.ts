import { describe, expect, it } from "vitest";
import {
  emptyIndex,
  newProject,
  openedProject,
  renamedProject,
  sortedProjects,
  withProject,
  withoutProject,
} from "./projects";

const at = (n: number) => 1_700_000_000_000 + n * 1000;

describe("the project list", () => {
  it("starts empty and keeps the newest design first", () => {
    const first = { ...newProject("First", at(1)), id: "a" };
    const second = { ...newProject("Second", at(2)), id: "b" };
    const ix = withProject(withProject(emptyIndex(), first), second);
    expect(sortedProjects(ix).map((p) => p.id)).toEqual(["b", "a"]);
  });

  it("replaces a design instead of listing it twice", () => {
    const meta = { ...newProject("One", at(1)), id: "a" };
    const ix = withProject(withProject(emptyIndex(), meta), { ...meta, name: "One again", updatedAt: at(5) });
    expect(ix.projects).toHaveLength(1);
    expect(ix.projects[0].name).toBe("One again");
  });

  it("remembers which design was open last, and moving to it refreshes its time", () => {
    const ix = withProject(withProject(emptyIndex(), { ...newProject("A", at(1)), id: "a" }), {
      ...newProject("B", at(2)),
      id: "b",
    });
    const opened = openedProject(ix, "a", at(9));
    expect(opened.lastId).toBe("a");
    expect(opened.projects.find((p) => p.id === "a")?.updatedAt).toBe(at(9));
    expect(sortedProjects(opened)[0].id).toBe("a");
  });

  it("renames without touching the other designs", () => {
    const ix = withProject(withProject(emptyIndex(), { ...newProject("A", at(1)), id: "a" }), {
      ...newProject("B", at(2)),
      id: "b",
    });
    const renamed = renamedProject(ix, "a", "Renamed", at(3));
    expect(renamed.projects.find((p) => p.id === "a")?.name).toBe("Renamed");
    expect(renamed.projects.find((p) => p.id === "b")?.name).toBe("B");
  });

  it("forgets the open design when it is deleted", () => {
    const ix = openedProject(withProject(emptyIndex(), { ...newProject("A", at(1)), id: "a" }), "a");
    const left = withoutProject(ix, "a");
    expect(left.projects).toHaveLength(0);
    expect(left.lastId).toBeUndefined();
  });
});
