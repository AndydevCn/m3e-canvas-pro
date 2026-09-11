import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalAdapter } from "./local";
import { PersistError } from "./types";
import { backupName, BACKUP_COUNT, FILE_NAME } from "./fsFile";
import type { Doc } from "../tokens";

/** the browser store, with a size limit so a full one can be simulated */
function fakeLocalStorage(limit = Infinity) {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (v.length > limit) {
        const e = new DOMException("full", "QuotaExceededError");
        throw e;
      }
      map.set(k, v);
    },
    removeItem: (k: string) => map.delete(k),
    clear: () => map.clear(),
  };
}

const doc = (): Doc => ({
  title: "Sketch",
  brief: "",
  paletteKey: "purple",
  frame: "phone",
  groups: [{ id: "g", x: 0, y: 0, axis: "y", items: [{ id: "i", kind: "button", label: "A", icon: null, variant: "filled" }] }],
  frames: [{ id: "f", name: "Home", x: 0, y: 0 }],
});

describe("LocalAdapter", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = fakeLocalStorage();
  });

  it("round-trips a document", async () => {
    const a = new LocalAdapter();
    await a.save(doc());
    expect(await a.load()).toEqual(doc());
  });

  it("returns null when there is nothing saved yet", async () => {
    expect(await new LocalAdapter().load()).toBeNull();
  });

  it("reports a full browser store as a quota error instead of swallowing it", async () => {
    (globalThis as { localStorage?: unknown }).localStorage = fakeLocalStorage(10);
    await expect(new LocalAdapter().save(doc())).rejects.toBeInstanceOf(PersistError);
    await expect(new LocalAdapter().save(doc())).rejects.toMatchObject({ reason: "quota" });
  });
});

describe("backup names", () => {
  it("keeps five generations next to the document", () => {
    expect(FILE_NAME).toBe("design.json");
    expect(backupName(1)).toBe("design.json.bak1");
    expect(backupName(BACKUP_COUNT)).toBe("design.json.bak5");
  });
});
