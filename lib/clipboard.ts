/**
 * Copying text to the clipboard.
 *
 * The async API is refused more often than one would expect: it needs the
 * document to be focused, and an iframe that was not granted `clipboard-write`
 * never gets it at all — which is exactly the case when the editor is shown
 * inside another page. The selection-based copy still works there, so it stays
 * as the fallback.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  if (await writeAsync(text)) return true;
  return writeBySelection(text);
}

async function writeAsync(text: string): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard) return false;
    if (typeof window !== "undefined" && !window.isSecureContext) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** the way it was done before the async API: put it in a field and copy it */
function writeBySelection(text: string): boolean {
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.left = "0";
    area.style.width = "1px";
    area.style.height = "1px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    const selection = document.getSelection();
    const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    area.remove();
    if (selection && previous) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
    return ok;
  } catch {
    return false;
  }
}
