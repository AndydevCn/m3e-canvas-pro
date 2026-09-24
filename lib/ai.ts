import { Doc, Frame, Group, Item, frameOfGroup, frameRect } from "./tokens";
import { buildPrompt } from "./prompt";
import { isProject, isScreenFragment } from "./project";
import { Lang } from "./i18n";

/* Optional AI helpers. The browser talks to the model provider directly with the
 * author's own key; there is no server in between. Every action has a fixed
 * prompt and a fixed JSON answer shape, and the result is only applied after the
 * author has looked at it. Coordinates are never touched by the model. */

export type Provider = "claude" | "openai" | "gemini" | "deepseek" | "mimo";

export type AiSettings = {
  provider: Provider;
  baseUrl: string;
  model: string;
  key: string;
};

/** the largest `max_tokens` a provider accepts, per its API docs; undefined means the
 *  provider is never sent a budget at all and uses its own generous default. A request
 *  that still blames max_tokens on a 400 falls back to the conservative 8192 (complete). */
export const PROVIDERS: { key: Provider; label: string; baseUrl: string; model: string; models?: string[]; urls?: { label: string; url: string }[]; keysUrl?: string; maxOut?: number }[] = [
  { key: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-5.6-luna", keysUrl: "https://platform.openai.com/api-keys" },
  { key: "claude", label: "Claude", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5", keysUrl: "https://console.anthropic.com/settings/keys", maxOut: 32768 },
  { key: "gemini", label: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-3.8-flash", keysUrl: "https://aistudio.google.com/apikey", maxOut: 65536 },
  { key: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-v4-flash", keysUrl: "https://platform.deepseek.com/api_keys", maxOut: 8192 },
  {
    key: "mimo",
    label: "Mimo",
    baseUrl: "https://api.xiaomimimo.com/v1",
    model: "mimo-v2.6-flash",
    models: ["mimo-v2.6-flash", "mimo-v2.6-pro"],
    /* Xiaomi MiMo bills two ways with two separate hosts: the token-plan pool and the
       pay-as-you-go API. Same protocol, different endpoint — see mimo.mi.com docs. */
    urls: [
      { label: "Token Plan", url: "https://token-plan-cn.xiaomimimo.com/v1" },
      { label: "按量付费", url: "https://api.xiaomimimo.com/v1" },
    ],
    keysUrl: "https://mimo.mi.com",
  },
];

export const providerSpec = (k: Provider) => PROVIDERS.find((p) => p.key === k) ?? PROVIDERS[0];

export const DEFAULT_AI: AiSettings = { provider: PROVIDERS[0].key, baseUrl: PROVIDERS[0].baseUrl, model: PROVIDERS[0].model, key: "" };

const STORE_KEY = "m3e:ai";

export function loadAiSettings(): AiSettings {
  const s = { ...DEFAULT_AI };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<AiSettings>;
      if (PROVIDERS.some((p) => p.key === v.provider)) s.provider = v.provider as Provider;
      if (typeof v.baseUrl === "string") s.baseUrl = v.baseUrl;
      if (typeof v.model === "string") s.model = v.model;
      if (typeof v.key === "string") s.key = v.key;
    }
  } catch {}
  return s;
}

/** Settings live in this browser only, like the document itself. */
export function saveAiSettings(s: AiSettings) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {}
}

const isLocal = (u: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(u.trim());

/** a hosted endpoint needs a key; a server on this machine may run without one */
export const hasKey = (s: AiSettings) => s.key.trim().length > 0 || isLocal(s.baseUrl);

/** the key must not travel over plain http, except to this machine */
export const isSecureUrl = (u: string) => /^https:\/\//i.test(u.trim()) || isLocal(u);

const trimSlash = (u: string) => u.trim().replace(/\/+$/, "");

async function readError(res: Response): Promise<string> {
  let detail = "";
  try {
    const j = await res.json();
    detail = j?.error?.message ?? j?.message ?? JSON.stringify(j);
  } catch {
    try {
      detail = await res.text();
    } catch {}
  }
  return `${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 300)}` : ""}`;
}

/** one round trip: a system prompt and a user message in, the model's text out. The
 *  output budget follows each provider's documented maximum; a provider that rejects the
 *  budget with a 400 about max_tokens gets one retry at the conservative 8192. */
export async function complete(s: AiSettings, system: string, user: string, signal?: AbortSignal, maxTokens = 4096): Promise<string> {
  const base = trimSlash(s.baseUrl);
  const model = s.model.trim();
  if (!model) throw new Error("model");
  if (!isSecureUrl(base)) throw new Error("insecure");
  /* OpenAI's newer models refuse `max_tokens` and default generously, so they get no budget;
     MiMo likewise speaks the newer dialect (max_completion_tokens, official default 131072
     including reasoning tokens), so it gets no budget either */
  const budget = Math.min(maxTokens, providerSpec(s.provider).maxOut ?? 8192);
  const blameBudget = (detail: string) => budget > 8192 && /max.?_?tokens?|budget|too large/i.test(detail);
  if (s.provider === "claude") {
    const send = (b: number) =>
      fetch(`${base}/v1/messages`, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": s.key.trim(),
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({ model, max_tokens: b, system, messages: [{ role: "user", content: user }] }),
      });
    let res = await send(budget);
    if (res.status === 400) {
      const detail = await readError(res);
      if (blameBudget(detail)) res = await send(8192);
      else throw new Error(detail);
    }
    if (!res.ok) throw new Error(await readError(res));
    const j = await res.json();
    if (j.stop_reason === "refusal") throw new Error("refusal");
    if (j.stop_reason === "max_tokens") throw new Error("long");
    return (j.content ?? [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("");
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (s.key.trim()) headers.authorization = `Bearer ${s.key.trim()}`;
  const send = (b: number | undefined) =>
    fetch(`${base}/chat/completions`, {
      method: "POST",
      signal,
      headers,
      body: JSON.stringify({
        model,
        ...(b ? { max_tokens: b } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
  const budgeted = s.provider === "openai" || s.provider === "mimo" ? undefined : budget;
  let res = await send(budgeted);
  if (res.status === 400 && budgeted) {
    const detail = await readError(res);
    if (blameBudget(detail)) res = await send(8192);
    else throw new Error(detail);
  }
  if (!res.ok) throw new Error(await readError(res));
  const j = await res.json();
  if (j.choices?.[0]?.finish_reason === "length") throw new Error("long");
  const c = j.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x: { text?: string }) => x.text ?? "").join("");
  throw new Error("empty");
}

/** the first JSON object in a reply, with any code fence stripped */
function parseJsonObject(text: string): Record<string, unknown> {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const a = cleaned.indexOf("{");
  const b = cleaned.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("json");
  const v = JSON.parse(cleaned.slice(a, b + 1));
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("json");
  return v as Record<string, unknown>;
}

/* ---------- actions ---------- */

const LANG_NAME: Record<Lang, string> = { ja: "Japanese", en: "English", zh: "Simplified Chinese", ko: "Korean" };

const hasText = (v?: string | null) => !!v && v.trim().length > 0;

const itemsOnFrame = (doc: Doc, frame: Frame, widths: Record<string, number>): Item[] =>
  doc.groups.filter((g: Group) => frameOfGroup(g, doc.frames, widths)?.id === frame.id).flatMap((g) => g.items);

const describeItem = (it: Item) => {
  const bits = [`id=${it.id}`, `kind=${it.kind}`];
  if (hasText(it.label)) bits.push(`label=${JSON.stringify(it.label)}`);
  if (hasText(it.supporting)) bits.push(`supporting=${JSON.stringify(it.supporting)}`);
  if (it.icon) bits.push(`icon=${it.icon}`);
  if (it.tabs?.length) bits.push(`items=${JSON.stringify(it.tabs.map((t) => t.label || t.icon))}`);
  if (it.action) bits.push(`tap=${it.action.to}`);
  if (it.toggle) bits.push("toggle");
  if (hasText(it.note)) bits.push(`current_note=${JSON.stringify(it.note)}`);
  return bits.join(" ");
};

const context = (doc: Doc, widths: Record<string, number>, frame: Frame, lang: Lang) =>
  [
    "The author is sketching a Material 3 Expressive app. Below is the generated description of the whole design, then the screen to work on.",
    "",
    "=== Whole design ===",
    buildPrompt(doc, widths, undefined, lang),
    "",
    `=== Screen to work on: ${JSON.stringify(frame.name || "(unnamed)")} ===`,
  ].join("\n");

const SYSTEM = "You help an app designer finish a sketch. Answer with a single JSON object and nothing else: no prose, no markdown fence.";

/** picks the strings the model returned for exactly the parts asked about */
function pickStrings(v: unknown, parts: Item[], max: number): Record<string, string> {
  const map = (v ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const it of parts) {
    const s = map[it.id];
    if (typeof s === "string" && s.trim()) out[it.id] = s.trim().slice(0, max);
  }
  return out;
}

/** a short behavior note for one part; an existing note is refined rather than replaced */
export async function proposeBehavior(s: AiSettings, doc: Doc, widths: Record<string, number>, frame: Frame, lang: Lang, itemId: string, signal?: AbortSignal): Promise<string | undefined> {
  const parts = itemsOnFrame(doc, frame, widths).filter((it) => it.id === itemId);
  if (!parts.length) return undefined;
  const user = [
    context(doc, widths, frame, lang),
    "",
    "For the part listed below, write what happens when the user interacts with it: what it does, where it leads, what it shows. One sentence, concrete, in the voice of a product spec (no 'should', no hedging). Infer from the labels, icons and the other screens; do not invent screens that do not exist.",
    "A part with a current_note already has the author's own wording: keep its intent and facts, and improve it (clearer, more specific, consistent with the rest of the screen). Do not contradict it.",
    `Write in ${LANG_NAME[lang]}.`,
    "",
    "Part:",
    describeItem(parts[0]),
    "",
    'Answer as {"notes": {"<id>": "<sentence>"}} using exactly the id above.',
  ].join("\n");
  const j = parseJsonObject(await complete(s, SYSTEM, user, signal));
  return pickStrings(j.notes, parts, 300)[itemId];
}

/** a name (only when the screen has none) and a one-line purpose for the screen; an existing description is refined */
export async function proposeDescription(s: AiSettings, doc: Doc, widths: Record<string, number>, frame: Frame, lang: Lang, signal?: AbortSignal): Promise<{ name?: string; note: string }> {
  const user = [
    context(doc, widths, frame, lang),
    "",
    "Describe this screen's purpose in one or two sentences: who opens it, what they see and what they can do here. Also propose a short screen name (one to three words).",
    hasText(frame.note) ? `The author's current description is ${JSON.stringify(frame.note)}: keep its intent and facts, and improve it.` : "",
    `Write in ${LANG_NAME[lang]}.`,
    "",
    'Answer as {"name": "<name>", "description": "<sentences>"}.',
  ]
    .filter((l) => l !== "")
    .join("\n");
  const j = parseJsonObject(await complete(s, SYSTEM, user, signal));
  const note = typeof j.description === "string" ? j.description.trim().slice(0, 400) : "";
  if (!note) throw new Error("json");
  const name = typeof j.name === "string" ? j.name.trim().slice(0, 40) : "";
  return { name: !hasText(frame.name) && name ? name : undefined, note };
}

/** the value a rewritten field had before, so the rewrite can be undone; an empty field leaves nothing to go back to */
export const pushHistory = (history: string[] | undefined, replaced: string | undefined): string[] | undefined => {
  const cur = (replaced ?? "").trim();
  return cur ? [cur] : history?.length ? history : undefined;
};

/** the patch that swaps a field with what it said before the AI wrote it; pressing again swaps back */
export function popHistory<V extends string, H extends string>(current: string | undefined, history: string[] | undefined, valueKey: V, historyKey: H): Record<V, string> & Record<H, string[] | undefined> {
  const [prev] = history ?? [];
  const cur = (current ?? "").trim();
  return { [valueKey]: prev ?? "", [historyKey]: cur ? [cur] : undefined } as Record<V, string> & Record<H, string[] | undefined>;
}

/** how far below the lowest existing screen a draft's new screens land */
const DRAFT_GAP = 80;

/** places a draft's new screens below everything already on the canvas, keeping the
 *  arrangement the model chose: the whole fragment is translated as one block */
export function mergeBelow(doc: Doc, frag: { frames: Frame[]; groups: Group[] }): Doc {
  const rects = doc.frames.map(frameRect);
  const targetX = rects.length ? Math.min(...rects.map((r) => r.l)) : 40;
  const targetY = rects.length ? Math.max(...rects.map((r) => r.b)) + DRAFT_GAP : 40;
  const fresh = frag.frames.map(frameRect);
  const dx = targetX - Math.min(...fresh.map((r) => r.l));
  const dy = targetY - Math.min(...fresh.map((r) => r.t));
  const shiftFrame = (f: Frame): Frame => ({ ...f, x: f.x + dx, y: f.y + dy });
  const shiftGroup = (g: Group): Group => ({ ...g, x: g.x + dx, y: g.y + dy });
  return { ...doc, frames: [...doc.frames, ...frag.frames.map(shiftFrame)], groups: [...doc.groups, ...frag.groups.map(shiftGroup)] };
}

/** swaps the model's edited screens into the design by id: each edited frame keeps its
 *  place on the canvas and the groups sitting on it are replaced wholesale; every other
 *  frame, group and id is untouched, so a partial request can never redraw the rest */
export function editInPlace(doc: Doc, frag: { frames: Frame[]; groups: Group[] }): Doc {
  const edited = new Map(frag.frames.map((f) => [f.id, f]));
  const unknown = [...edited.keys()].filter((id) => !doc.frames.some((f) => f.id === id));
  if (unknown.length) throw new Error("json");
  const frames = doc.frames.map((f) => {
    const next = edited.get(f.id);
    return next ? { ...next, x: f.x, y: f.y } : f;
  });
  const onEditedScreen = (g: Group) =>
    doc.frames.some((f) => {
      if (!edited.has(f.id)) return false;
      const r = frameRect(f);
      return g.x >= r.l && g.x <= r.r && g.y >= r.t && g.y <= r.b;
    });
  return { ...doc, frames, groups: [...doc.groups.filter((g) => !onEditedScreen(g)), ...frag.groups] };
}

/** applies a draft reply. "add" appends only the new screens below the current ones;
 *  "edit" swaps the named screens in by id, leaving the rest of the design untouched;
 *  "replace" swaps the whole design with the edited one (a bare document, the old reply
 *  shape, still works). Anything else is unreadable. */
export function applyDraft(current: Doc, reply: Record<string, unknown>): Doc {
  if (reply.mode === "add") {
    const frag = (reply.doc ?? reply) as unknown;
    if (isScreenFragment(frag)) return mergeBelow(current, frag);
    throw new Error("json");
  }
  if (reply.mode === "edit") {
    if (isScreenFragment(reply)) return editInPlace(current, reply);
    throw new Error("json");
  }
  const doc = (reply.mode === "replace" ? reply.doc : reply) as unknown;
  if (isProject(doc)) return doc;
  throw new Error("json");
}

/** A design change from an idea, drafted by the author's own model. `guide` is the same
 *  agent guide a coding agent reads (public/agent.md), so both paths follow one spec.
 *  The idea either asks for a new screen — the reply adds it below the existing ones, which
 *  stay untouched — or for changes to a few screens, and the reply names just those screens
 *  so the app swaps them in by id, or for design-wide changes, and the reply is the whole
 *  design. arrive() keeps the previous design one undo away either way. */
export async function draftDesign(s: AiSettings, guide: string, idea: string, lang: Lang, current: Doc, signal?: AbortSignal): Promise<Doc> {
  const system = [
    "You edit M3E Canvas designs. The guide below defines the document format.",
    "After it come the author's current design as JSON (it may be empty) and then the idea.",
    "",
    guide,
    "",
    "=== Current design (JSON) ===",
    JSON.stringify(current),
    "",
    "=== How to answer ===",
    'If the idea asks for a new screen or new screens, reply with {"mode":"add","frames":[…],"groups":[…]}: only the new frames and the groups inside them, laid out left to right from x 40 y 40 with 60 between frames. Do not repeat any current screen. One or two screens; keep it simple.',
    'If the idea asks to change one or a few existing screens or the parts on them, reply with {"mode":"edit","frames":[…],"groups":[…]}: only the edited frames and every group that sits on them. Reuse the edited frames\' existing ids and the groups\' existing ids; include the groups you keep as they are and leave out the ones the idea removes. The app swaps these in by id and keeps every screen you do not return exactly as it is, so never re-output other screens.',
    'Only if the idea changes what a screen edit cannot express — theme, title, brief, removing whole screens, or reworking nearly the whole design — reply with {"mode":"replace","doc":{…}}: the whole design with only the requested changes; keep every other screen, part and id exactly as it is.',
    "The app places added screens itself and keeps edited screens where they are, so a frame's x and y do not matter in an add or edit reply.",
    "Reply with that one JSON object and nothing else: no prose, no markdown fence, no share link, no explanation.",
  ].join("\n");
  const user = [`Idea: ${idea.trim()}`, `Write every label, title and note in ${LANG_NAME[lang]}.`].join("\n");
  const j = parseJsonObject(await complete(s, system, user, signal, 12000));
  return applyDraft(current, j);
}

