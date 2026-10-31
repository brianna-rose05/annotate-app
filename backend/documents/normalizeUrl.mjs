// Turn the many ways of linking to one article into a single URL, so it's only saved once.
// No dependencies, so the frontend's tests can import it directly.

const TRACKING_PARAMS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid", "ref", "ref_src"]);

// arxiv.org/abs/2301.01234v2, /pdf/2301.01234, /pdf/2301.01234v1.pdf → the ID "2301.01234"
// (old-style IDs like "hep-th/9901001" contain a slash, so the ID can span path segments)
const ARXIV_PATH = /^\/(?:abs|pdf)\/(.+?)(?:v\d+)?(?:\.pdf)?$/i;

export function normalizeUrl(url) {
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return url;
  }

  if (parsed.protocol === "http:") parsed.protocol = "https:";
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  parsed.hash = "";

  const path = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, "") : parsed.pathname;

  // arXiv: always the PDF, without a version, so it opens in the PDF viewer
  if (parsed.hostname === "arxiv.org") {
    const match = path.match(ARXIV_PATH);
    if (match) return `https://arxiv.org/pdf/${match[1]}`;
  }

  parsed.pathname = path || "/";

  const isSubstack = parsed.hostname === "substack.com" || parsed.hostname.endsWith(".substack.com");
  for (const key of [...parsed.searchParams.keys()]) {
    const k = key.toLowerCase();
    if (k.startsWith("utm_") || TRACKING_PARAMS.has(k) || (isSubstack && k === "s")) {
      parsed.searchParams.delete(key);
    }
  }

  return parsed.href;
}
