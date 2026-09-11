/* One tab edits the canvas; the others stay read-only so two writers cannot
 * overwrite each other. That guard used to be a dead end: the only way out was
 * to hunt down the other tab and reload. These messages let a later tab ask the
 * holder to hand the editor over instead. */

const CHANNEL = "m3e:editor";
/** how long the requester waits for the holder to answer before forcing it */
const REPLY_TIMEOUT_MS = 1200;

type Msg = { type: "ask-release" } | { type: "released" };

const supported = () => typeof BroadcastChannel !== "undefined";

/** the holder's side: run `onAsk` when another tab wants the editor */
export function listenForHandover(onAsk: () => void): () => void {
  if (!supported()) return () => undefined;
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = (e: MessageEvent<Msg>) => {
    if (e.data?.type === "ask-release") onAsk();
  };
  return () => ch.close();
}

/** told by the holder just after it let go of the lock */
export function announceRelease(): void {
  if (!supported()) return;
  const ch = new BroadcastChannel(CHANNEL);
  ch.postMessage({ type: "released" } satisfies Msg);
  ch.close();
}

/** the requester's side: true when the holder answered and let go */
export function askForHandover(): Promise<boolean> {
  if (!supported()) return Promise.resolve(false);
  return new Promise((resolve) => {
    const ch = new BroadcastChannel(CHANNEL);
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      ch.close();
      resolve(ok);
    };
    const timer = window.setTimeout(() => finish(false), REPLY_TIMEOUT_MS);
    ch.onmessage = (e: MessageEvent<Msg>) => {
      if (e.data?.type === "released") finish(true);
    };
    ch.postMessage({ type: "ask-release" } satisfies Msg);
  });
}
