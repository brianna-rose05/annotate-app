import http from "node:http";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const PORT = process.env.PORT || 3000;
const SECRET = process.env.FETCHER_SECRET; // only callers who know this can use the service

// Turn relative links/images ("x4.png") into full URLs on the original site
function absolutizeUrls(html, baseUrl) {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);

  for (const el of document.querySelectorAll("img[src], source[src]")) {
    try {
      el.setAttribute("src", new URL(el.getAttribute("src"), baseUrl).href);
    } catch {}
    el.removeAttribute("srcset");
  }

  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    if (href.startsWith("#")) continue;
    try {
      a.setAttribute("href", new URL(href, baseUrl).href);
    } catch {}
  }

  return document.body.innerHTML;
}

async function fetchArticle(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; AnnotateApp/1.0)" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Page returned ${res.status}`);

  const html = await res.text();
  const { document } = parseHTML(html);

  const baseHref = document.querySelector("base")?.getAttribute("href");
  const baseUrl = baseHref ? new URL(baseHref, res.url).href : res.url;

  const article = new Readability(document).parse();
  if (!article) throw new Error("Couldn't find an article on that page");

  article.content = absolutizeUrls(article.content, baseUrl);
  return article;
}

const send = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};

const server = http.createServer(async (req, res) => {
  // Health check: lets you (and AWS) confirm the server is alive
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });

  if (req.method !== "POST" || req.url !== "/fetch") return send(res, 404, { error: "not found" });
  if (req.headers["x-fetcher-secret"] !== SECRET) return send(res, 401, { error: "unauthorized" });

  let body = "";
  for await (const chunk of req) body += chunk;

  try {
    const { url } = JSON.parse(body);
    send(res, 200, await fetchArticle(url));
  } catch (err) {
    send(res, 422, { error: err.message });
  }
});

server.listen(PORT, () => console.log(`Fetcher listening on port ${PORT}`));