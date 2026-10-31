// Make the links and images in a saved article point at the original site.
// Shared by the backend (when saving) and the frontend reader (for articles saved earlier),
// so it has no dependencies and only uses DOM methods that linkedom and browsers both have.

// "a.jpg 1x, /b.jpg 2x" → [{ url: "a.jpg", descriptor: "1x" }, { url: "/b.jpg", descriptor: "2x" }]
// A URL ends at whitespace (it may contain commas); its descriptor ends at the next comma.
export function parseSrcset(srcset) {
  const candidates = [];
  let i = 0;
  while (i < srcset.length) {
    while (i < srcset.length && /[\s,]/.test(srcset[i])) i++; // skip separators
    if (i >= srcset.length) break;

    let start = i;
    while (i < srcset.length && !/\s/.test(srcset[i])) i++;
    let url = srcset.slice(start, i);
    let descriptor = "";

    if (url.endsWith(",")) {
      url = url.replace(/,+$/, ""); // "a.jpg, b.jpg": no descriptor
    } else {
      start = i;
      while (i < srcset.length && srcset[i] !== ",") i++;
      descriptor = srcset.slice(start, i).trim();
    }
    if (url) candidates.push({ url, descriptor });
  }
  return candidates;
}

export function serializeSrcset(candidates) {
  return candidates.map((c) => (c.descriptor ? `${c.url} ${c.descriptor}` : c.url)).join(", ");
}

// Next.js serves images through /_next/image?url=<real image>&w=…; use the real image instead,
// since the optimizer only works on the original site
function unwrapNextImage(url, base) {
  const inner = url.pathname.endsWith("/_next/image") && url.searchParams.get("url");
  if (!inner) return url;
  try {
    return new URL(inner, base);
  } catch {
    return url;
  }
}

// One URL → absolute, against the article's address. Anything unparseable is left alone.
export function resolveUrl(value, base) {
  try {
    return unwrapNextImage(new URL(value.trim(), base), base).href;
  } catch {
    return value;
  }
}

export function resolveSrcset(srcset, base) {
  return serializeSrcset(
    parseSrcset(srcset).map((c) => ({ ...c, url: resolveUrl(c.url, base) })),
  );
}

// Fix every image source and link inside `root` (an element or document)
export function fixArticleUrls(root, base) {
  for (const el of root.querySelectorAll("img, source")) {
    const src = el.getAttribute("src");
    if (src) el.setAttribute("src", resolveUrl(src, base));
    const srcset = el.getAttribute("srcset");
    if (srcset) el.setAttribute("srcset", resolveSrcset(srcset, base));
  }

  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    if (href.startsWith("#")) continue; // jumps within the article
    a.setAttribute("href", resolveUrl(href, base));
  }
}
