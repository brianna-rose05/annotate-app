import http from "node:http";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const PORT = process.env.PORT || 3000;
const SECRET = process.env.FETCHER_SECRET; // only callers who know this can use the service

async function fetchArticle(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; AnnotateApp/1.0)" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Page returned ${res.status}`);
  const { document } = parseHTML(await res.text());
  const article = new Readability(document).parse();
  if (!article) throw new Error("Couldn't find an article on that page");
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

server.listen(PORT, () => console.log(`Fetcher v2 listening on port ${PORT}`));