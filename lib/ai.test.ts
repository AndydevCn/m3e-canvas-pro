import { afterEach, describe, expect, it, vi } from "vitest";
import { applyDraft, complete, hasKey, isSecureUrl, mergeBelow, type AiSettings, type Provider } from "./ai";
import { Doc } from "./tokens";

const settings = (over: Partial<AiSettings> = {}): AiSettings =>
  ({ provider: "openai", baseUrl: "https://api.example.test", model: "test-model", key: "test-key", ...over });

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => vi.unstubAllGlobals());

describe("complete on the claude path", () => {
  it("posts to the messages endpoint with the anthropic headers and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ content: [{ type: "text", text: "hi" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const s = settings({ provider: "claude", baseUrl: "https://api.example.test/", key: "  test-key  " });
    await expect(complete(s, "sys prompt", "user prompt")).resolves.toBe("hi");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.test/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      "x-api-key": "test-key",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    });
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: "test-model", max_tokens: 4096, system: "sys prompt", messages: [{ role: "user", content: "user prompt" }] });
  });

  it("joins only the text blocks of the reply", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      content: [{ type: "text", text: "a" }, { type: "tool_use", id: "t" }, { type: "text", text: "b" }],
    })));
    await expect(complete(settings({ provider: "claude" }), "s", "u")).resolves.toBe("ab");
  });

  it("returns an empty string for an empty content array instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ content: [] })));
    await expect(complete(settings({ provider: "claude" }), "s", "u")).resolves.toBe("");
  });

  it("throws long when the reply stops at max_tokens", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ content: [{ type: "text", text: "partial" }], stop_reason: "max_tokens" })));
    await expect(complete(settings({ provider: "claude" }), "s", "u")).rejects.toThrow("long");
  });

  it("throws refusal when the model refuses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ content: [], stop_reason: "refusal" })));
    await expect(complete(settings({ provider: "claude" }), "s", "u")).rejects.toThrow("refusal");
  });

  it("throws the status and provider detail on an http error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529, statusText: "Overloaded" })));
    await expect(complete(settings({ provider: "claude" }), "s", "u")).rejects.toThrow("529 Overloaded: overloaded");
  });
});

describe("complete on the openai-compatible path", () => {
  it("sends bearer auth and omits max_tokens for the openai provider", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(complete(settings(), "sys prompt", "user prompt")).resolves.toBe("ok");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.test/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json", authorization: "Bearer test-key" });
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: "test-model", messages: [{ role: "system", content: "sys prompt" }, { role: "user", content: "user prompt" }] });
    expect(body).not.toHaveProperty("max_tokens");
  });

  it.each(["gemini", "deepseek"] as Provider[])("sends a max_tokens budget to %s", async (provider) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(complete(settings({ provider }), "s", "u")).resolves.toBe("ok");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(4096);
  });

  it("raises the gemini budget for a long draft and falls back to 8192 when the endpoint refuses it", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "max_tokens is too large: 12000. This model supports at most 8192." } }, 400))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(complete(settings({ provider: "gemini" }), "s", "u", undefined, 12000)).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(12000);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).max_tokens).toBe(8192);
  });

  it("posts mimo with bearer auth and no max_tokens (it speaks the newer max_completion_tokens dialect)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(complete(settings({ provider: "mimo", baseUrl: "https://api.xiaomimimo.com/v1" }), "s", "u")).resolves.toBe("ok");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.xiaomimimo.com/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer test-key");
    expect(JSON.parse(init.body)).not.toHaveProperty("max_tokens");
  });

  it("calls a local endpoint without a key and without an authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: "local" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const s = settings({ baseUrl: "http://localhost:11434/v1/", key: "" });
    await expect(complete(s, "s", "u")).resolves.toBe("local");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    expect(init.headers).toEqual({ "content-type": "application/json" });
  });

  it("joins array content parts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: [{ text: "a" }, {}, { text: "b" }] } }] })));
    await expect(complete(settings(), "s", "u")).resolves.toBe("ab");
  });

  it("throws long when finish_reason is length", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ choices: [{ finish_reason: "length", message: { content: "partial" } }] })));
    await expect(complete(settings(), "s", "u")).rejects.toThrow("long");
  });

  it("throws the status and provider detail on an http error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401, statusText: "Unauthorized" })));
    await expect(complete(settings(), "s", "u")).rejects.toThrow("401 Unauthorized: bad key");
  });

  it("throws empty when the reply has no content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ choices: [{ finish_reason: "stop", message: {} }] })));
    await expect(complete(settings(), "s", "u")).rejects.toThrow("empty");
  });
});

describe("complete input guards", () => {
  it.each([
    ["insecure", { baseUrl: "http://api.example.test" }],
    ["model", { model: "  " }],
  ])("rejects %s without calling fetch", async (message, over) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(complete(settings(over), "s", "u")).rejects.toThrow(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("hasKey and isSecureUrl", () => {
  it("requires a key for hosted endpoints but not for this machine", () => {
    expect(hasKey(settings())).toBe(true);
    expect(hasKey(settings({ key: "  " }))).toBe(false);
    expect(hasKey(settings({ key: "", baseUrl: "http://localhost:11434/v1" }))).toBe(true);
  });

  it("only allows https or an endpoint on this machine", () => {
    expect(isSecureUrl("https://api.example.test/v1")).toBe(true);
    expect(isSecureUrl("http://localhost:8080/v1")).toBe(true);
    expect(isSecureUrl("http://127.0.0.1:8080/v1")).toBe(true);
    expect(isSecureUrl("http://[::1]:8080/v1")).toBe(true);
    expect(isSecureUrl("http://api.example.test/v1")).toBe(false);
  });
});

describe("applyDraft / mergeBelow", () => {
  const baseDoc = (): Doc => ({
    groups: [],
    frames: [{ id: "f1", name: "Home", x: 40, y: 40, w: 412, h: 892 }],
    paletteKey: "baseline",
    frame: "phone",
    title: "Test",
    brief: "",
  });

  const frag = (x = 0, y = 0) => ({
    frames: [{ id: "f2", name: "Next", x, y }],
    groups: [
      {
        id: "g1",
        x: x + 20,
        y: y + 30,
        axis: "x" as const,
        items: [{ id: "i1", kind: "button", variant: "filled", label: "Hi", icon: null }],
      },
    ],
  });

  it("places an added screen below the existing ones and shifts its groups with it", () => {
    const out = applyDraft(baseDoc(), { mode: "add", ...frag() });
    expect(out.frames).toHaveLength(2);
    expect(out.frames[1]).toMatchObject({ id: "f2", x: 40, y: 40 + 892 + 80 });
    expect(out.groups[0]).toMatchObject({ id: "g1", x: 60, y: 1042 });
  });

  it("accepts an add reply that wraps the fragment in doc", () => {
    const out = applyDraft(baseDoc(), { mode: "add", doc: frag() });
    expect(out.frames.map((f) => f.id)).toEqual(["f1", "f2"]);
  });

  it("lands an added screen at 40 40 on an empty canvas", () => {
    const empty = { ...baseDoc(), frames: [] };
    const out = applyDraft(empty, { mode: "add", ...frag(100, 200) });
    expect(out.frames[0]).toMatchObject({ id: "f2", x: 40, y: 40 });
    expect(out.groups[0]).toMatchObject({ x: 60, y: 70 });
  });

  it("swaps the whole design for a replace reply", () => {
    const next = baseDoc();
    next.frames.push({ id: "f9", name: "Extra", x: 600, y: 40 });
    expect(applyDraft(baseDoc(), { mode: "replace", doc: next })).toBe(next);
  });

  it("still accepts a bare document reply (the old shape)", () => {
    const next = baseDoc();
    expect(applyDraft(baseDoc(), next)).toBe(next);
  });

  it("edits swap only the named screens in by id and keep their place", () => {
    const doc = baseDoc();
    doc.frames.push({ id: "f2", name: "Stats", x: 500, y: 40, w: 412, h: 892 });
    doc.groups.push(
      { id: "g1", x: 60, y: 70, axis: "x", items: [{ id: "i1", kind: "button", variant: "filled", label: "Old", icon: null }] },
      { id: "g2", x: 520, y: 70, axis: "x", items: [{ id: "i2", kind: "button", variant: "filled", label: "Keep", icon: null }] },
    );
    const out = applyDraft(doc, {
      mode: "edit",
      frames: [{ id: "f1", name: "Home v2", x: 9999, y: 9999 }],
      groups: [{ id: "g1", x: 60, y: 70, axis: "x", items: [{ id: "i1", kind: "button", variant: "filled", label: "New", icon: null }] }],
    });
    expect(out.frames.map((f) => f.id)).toEqual(["f1", "f2"]);
    expect(out.frames[0]).toMatchObject({ id: "f1", name: "Home v2", x: 40, y: 40 });
    expect(out.frames[1]).toMatchObject({ id: "f2", name: "Stats", x: 500, y: 40 });
    expect(out.groups.map((g) => g.id)).toEqual(["g2", "g1"]);
    expect(out.groups.find((g) => g.id === "g1")!.items[0]).toMatchObject({ label: "New" });
    expect(out.groups.find((g) => g.id === "g2")!.items[0]).toMatchObject({ label: "Keep" });
  });

  it("an edit reply that omits a group of the edited screen removes it", () => {
    const doc = baseDoc();
    doc.frames.push({ id: "f2", name: "Stats", x: 500, y: 40, w: 412, h: 892 });
    doc.groups.push(
      { id: "g1", x: 60, y: 70, axis: "x", items: [{ id: "i1", kind: "button", variant: "filled", label: "Old", icon: null }] },
      { id: "g2", x: 520, y: 70, axis: "x", items: [{ id: "i2", kind: "button", variant: "filled", label: "Keep", icon: null }] },
    );
    const out = applyDraft(doc, { mode: "edit", frames: [{ id: "f1", name: "Home", x: 40, y: 40 }], groups: [] });
    expect(out.groups.map((g) => g.id)).toEqual(["g2"]);
  });

  it("throws json when an edit reply names a screen the design does not have", () => {
    expect(() => applyDraft(baseDoc(), { mode: "edit", frames: [{ id: "nope", name: "X", x: 0, y: 0 }], groups: [] })).toThrow("json");
  });

  it("throws json for an edit reply without valid frames", () => {
    expect(() => applyDraft(baseDoc(), { mode: "edit", frames: [], groups: [] })).toThrow("json");
  });

  it("throws json for an add reply without frames", () => {
    expect(() => applyDraft(baseDoc(), { mode: "add", frames: [], groups: [] })).toThrow("json");
    expect(() => applyDraft(baseDoc(), { mode: "add", doc: { frames: "no" } })).toThrow("json");
  });

  it("mergeBelow keeps the model's arrangement as one translated block", () => {
    const f = mergeBelow(baseDoc(), {
      frames: [
        { id: "a", name: "A", x: 0, y: 0 },
        { id: "b", name: "B", x: 472, y: 0 },
      ],
      groups: [],
    });
    expect(f.frames.map((x) => x.x)).toEqual([40, 40, 512]);
    expect(f.frames[1]).toMatchObject({ id: "a", y: 1012 });
    expect(f.frames[2]).toMatchObject({ id: "b", y: 1012 });
  });
});
