/**
 * Helpers for turning the canvas into a picture.
 *
 * html-to-image walks every stylesheet of the document to embed the fonts it
 * finds. Reading one that the browser marked "not origin-clean" — any
 * stylesheet served by another host without CORS, such as the optional display
 * faces the theme loads from Google Fonts — throws a SecurityError. The library
 * survives it, but the console fills up and the dev overlay reports an issue on
 * every capture. Those sheets could never be embedded anyway, so they are
 * parked while the picture is taken and put back afterwards.
 */

/** the stylesheets whose rules the browser refuses to hand out */
function unreadableSheets(): HTMLLinkElement[] {
  return Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).filter((link) => {
    try {
      /* the read itself is what throws for a foreign sheet */
      return link.sheet != null && link.sheet.cssRules == null;
    } catch {
      return true;
    }
  });
}

/** takes a picture with every unreadable stylesheet out of the way */
export async function captureWithoutForeignFonts<T>(capture: () => Promise<T>): Promise<T> {
  if (typeof document === "undefined") return capture();
  const parked = unreadableSheets().map((link) => ({ link, parent: link.parentNode }));
  if (parked.length === 0) return capture();
  for (const { link } of parked) link.remove();
  try {
    return await capture();
  } finally {
    for (const { link, parent } of parked) parent?.appendChild(link);
  }
}
