import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

/* The project keeps its dependencies lean and has no DOM environment, so the
   browser is stubbed just enough to exercise the fallback path. */
function stubDocument(copySucceeds: boolean) {
  const inBody: FakeElement[] = [];
  const created: FakeElement[] = [];
  const document = {
    createElement: () => {
      const el: FakeElement = {
        value: "",
        style: {} as Record<string, string>,
        setAttribute: () => {},
        select: () => {},
        setSelectionRange: () => {},
        remove: () => {
          const at = inBody.indexOf(el);
          if (at >= 0) inBody.splice(at, 1);
        },
      };
      created.push(el);
      return el;
    },
    body: {
      appendChild: (el: FakeElement) => {
        inBody.push(el);
        return el;
      },
    },
    getSelection: () => null,
    execCommand: (command: string) => command === "copy" && copySucceeds,
  };
  vi.stubGlobal("document", document);
  return { created, inBody };
}

interface FakeElement {
  value: string;
  style: Record<string, string>;
  setAttribute: () => void;
  select: () => void;
  setSelectionRange: () => void;
  remove: () => void;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyText", () => {
  it("copies through a hidden field when the clipboard API is unavailable", async () => {
    const { created, inBody } = stubDocument(true);
    await expect(copyText("hello")).resolves.toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0].value).toBe("hello");
    /* the field is taken out again, so nothing is left on the canvas */
    expect(inBody).toHaveLength(0);
  });

  it("reports failure when neither way can copy", async () => {
    const { inBody } = stubDocument(false);
    await expect(copyText("hello")).resolves.toBe(false);
    expect(inBody).toHaveLength(0);
  });
});
