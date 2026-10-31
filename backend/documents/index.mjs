import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
  BatchGetCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { getDocumentProxy, extractText } from "unpdf";
import { randomUUID, createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { normalizeUrl } from "./normalizeUrl.mjs";
import { fixArticleUrls } from "./articleUrls.mjs";

// removeUndefinedValues: skip fields that are undefined (e.g. pdfKey for web pages)
// instead of throwing an error
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});


const TABLE = process.env.TABLE_NAME;
const BUCKET = process.env.CONTENT_BUCKET;
const ANNOTATIONS_TABLE = process.env.ANNOTATIONS_TABLE;
const COLLECTIONS_TABLE = process.env.COLLECTIONS_TABLE;
const COLLECTION_ITEMS_TABLE = process.env.COLLECTION_ITEMS_TABLE;
const FETCHER_URL = process.env.FETCHER_URL;
const FETCHER_SECRET = process.env.FETCHER_SECRET;
const LEGACY_OWNER_SUB = "4498f438-80c1-7011-ab5b-affb6371d0e8";
const DEMO_SUB = "34a8e4b8-c071-70f9-5413-db7ec45277fe"; // brianna.pischke+demo@gmail.com: read-only
let USER_ID; 



const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // Lambda responses max out at 6MB, and base64 adds ~33%

// Private/internal network addresses. A proxy must never fetch these (an attack called SSRF)
function isPrivateAddress(ip) {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7)); // IPv4 written as IPv6
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 || a === 127 || a === 0 ||
    (a === 169 && b === 254) ||          // cloud metadata addresses
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

// Only allow normal public web addresses
async function assertPublicUrl(raw) {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only web links are allowed");
  const addresses = await lookup(url.hostname, { all: true }); // what IP the name really points to
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new Error("That address isn't allowed");
  return url;
}

// Fetch an image from another site and return it from OUR API, which the browser allows
async function proxyImage(src) {
  let url = await assertPublicUrl(src);
  let res;
  // Follow redirects ourselves, checking each new address (a redirect could point somewhere private)
  for (let hops = 0; hops < 4; hops++) {
    res = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0 (Annotate image proxy)" },
      signal: AbortSignal.timeout(8000),
    });
    const next = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && next) {
      url = await assertPublicUrl(new URL(next, url).toString());
      continue;
    }
    break;
  }

  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.startsWith("image/")) {
    return { statusCode: 400, body: JSON.stringify({ error: "That link isn't an image" }) };
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) {
    return { statusCode: 413, body: JSON.stringify({ error: "That image is too large" }) };
  }
  return {
    statusCode: 200,
    isBase64Encoded: true, // tells API Gateway the body is an image, not text
    headers: { "Content-Type": type, "Cache-Control": "public, max-age=86400" },
    body: bytes.toString("base64"),
  };
}


const json = (statusCode, data) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});

// =====================================================================
// General helpers
// =====================================================================

// Same URL → same ID, so saving a link twice doesn't create a duplicate
function docIdFor(url) {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

// Titles count as the same if they only differ in capitals or spacing
function titleKey(title) {
  return (title ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

// A saved article with the same title, other than `exceptDocId` (null if none)
async function findByTitle(title, exceptDocId) {
  const key = titleKey(title);
  if (!key) return null;
  let lastKey;
  do {
    const { Items, LastEvaluatedKey } = await db.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "userId = :u",
      ExpressionAttributeValues: { ":u": USER_ID },
      ExclusiveStartKey: lastKey,
    }));
    const match = Items.find(
      (d) => d.docId !== exceptDocId && d.status !== "failed" && titleKey(d.title) === key
    );
    if (match) return match;
    lastKey = LastEvaluatedKey;
  } while (lastKey);
  return null;
}

// "AI & Skill Loss" → "ai-skill-loss" (safe to use in a URL)
function slugify(name) {
  return (name ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

// DynamoDB "string sets" come back as JavaScript Sets, which JSON can't represent.
// Convert to a plain array before sending a highlight to the browser.
function toClient(item) {
  if (!item) return item;
  const { collectionIds, ...rest } = item;
  return { ...rest, collectionIds: collectionIds ? [...collectionIds] : [] };
}

// Snips: attach a temporary view link to the image (the bucket stays private)
async function withImageUrl(item) {
  const out = toClient(item);
  if (out?.imageKey) {
    out.imageUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: out.imageKey }),
      { expiresIn: 3600 } // valid for 1 hour
    );
  }
  return out;
}

// The article's title and URL, copied onto each highlight. Returns null if the article doesn't exist.
async function getDocInfo(docId) {
  const { Item } = await db.send(new GetCommand({
    TableName: TABLE,
    Key: { userId: USER_ID, docId },
  }));
  if (!Item) return null;
  return { docTitle: Item.title ?? Item.url, docUrl: Item.url };
}

// The annotations table is keyed by docId, and every user who saves the same link gets the same
// docId. So every read and write of a highlight must also check its userId.

// This user's highlights on one article
async function myAnnotations(docId) {
  const { Items } = await db.send(new QueryCommand({
    TableName: ANNOTATIONS_TABLE,
    KeyConditionExpression: "docId = :d",
    FilterExpression: "userId = :u",
    ExpressionAttributeValues: { ":d": docId, ":u": USER_ID },
  }));
  return Items;
}

// One of this user's highlights, or null (also null if it belongs to someone else)
async function getMyAnnotation(docId, annotationId) {
  const { Item } = await db.send(new GetCommand({
    TableName: ANNOTATIONS_TABLE,
    Key: { docId, annotationId },
  }));
  return Item?.userId === USER_ID ? Item : null;
}

// Delete one of this user's highlights, plus its snip image and collection memberships.
// Returns false if it doesn't exist or isn't theirs.
async function deleteMyAnnotation(docId, annotationId) {
  let Attributes;
  try {
    ({ Attributes } = await db.send(new DeleteCommand({
      TableName: ANNOTATIONS_TABLE,
      Key: { docId, annotationId },
      ConditionExpression: "userId = :u", // fails if it's missing or someone else's
      ExpressionAttributeValues: { ":u": USER_ID },
      ReturnValues: "ALL_OLD",
    })));
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
  await removeFromCollections(annotationId, [...(Attributes.collectionIds ?? [])]);
  if (Attributes.imageKey) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: Attributes.imageKey }));
  }
  return true;
}

// =====================================================================
// Collection helpers
// =====================================================================

const collectionKeyFor = (collectionId) => `${USER_ID}#${collectionId}`;

// All of my collections (there are only ever a handful, so one query is fine)
async function listCollections() {
  const { Items } = await db.send(new QueryCommand({
    TableName: COLLECTIONS_TABLE,
    KeyConditionExpression: "userId = :u",
    ExpressionAttributeValues: { ":u": USER_ID },
  }));
  return Items;
}

// Find a collection by name (ignoring capitals), or create it. Returns { collectionId, name }.
async function resolveCollection(rawName) {
  const name = rawName.trim();
  const all = await listCollections();

  const existing = all.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (existing) return { collectionId: existing.collectionId, name: existing.name };

  // New collection: use the slug as its ID, unless a renamed collection already has that ID
  let collectionId = slugify(name) || "collection";
  if (all.some((c) => c.collectionId === collectionId)) {
    collectionId = `${collectionId}-${randomUUID().slice(0, 6)}`;
  }

  await db.send(new PutCommand({
    TableName: COLLECTIONS_TABLE,
    Item: { userId: USER_ID, collectionId, name, createdAt: new Date().toISOString() },
  }));
  return { collectionId, name };
}

// A list of names → a list of collection IDs (creating any that don't exist yet)
async function resolveCollections(names = []) {
  const ids = [];
  for (const name of names) {
    if (!name?.trim()) continue;
    const { collectionId } = await resolveCollection(name);
    if (!ids.includes(collectionId)) ids.push(collectionId);
  }
  return ids;
}

// Membership rows: "this highlight is in these collections"
async function addToCollections(annotation, collectionIds) {
  for (const collectionId of collectionIds) {
    await db.send(new PutCommand({
      TableName: COLLECTION_ITEMS_TABLE,
      Item: {
        collectionKey: collectionKeyFor(collectionId),
        annotationId: annotation.annotationId,
        docId: annotation.docId,
        createdAt: annotation.createdAt,
      },
    }));
  }
}

async function removeFromCollections(annotationId, collectionIds) {
  for (const collectionId of collectionIds) {
    await db.send(new DeleteCommand({
      TableName: COLLECTION_ITEMS_TABLE,
      Key: { collectionKey: collectionKeyFor(collectionId), annotationId },
    }));
  }
}

// The membership rows for one collection
async function collectionMembers(collectionId) {
  const { Items } = await db.send(new QueryCommand({
    TableName: COLLECTION_ITEMS_TABLE,
    KeyConditionExpression: "collectionKey = :k",
    ExpressionAttributeValues: { ":k": collectionKeyFor(collectionId) },
  }));
  return Items;
}

// Every highlight in a collection, newest first (with image links for snips)
async function collectionHighlights(collectionId) {
  const members = await collectionMembers(collectionId);
  const highlights = [];

  // BatchGet fetches up to 100 items per request
  for (let i = 0; i < members.length; i += 100) {
    const keys = members.slice(i, i + 100).map((m) => ({ docId: m.docId, annotationId: m.annotationId }));
    const res = await db.send(new BatchGetCommand({
      RequestItems: { [ANNOTATIONS_TABLE]: { Keys: keys } },
    }));
    // Membership rows are per-user, but double-check each highlight is really this user's
    highlights.push(...res.Responses[ANNOTATIONS_TABLE].filter((h) => h.userId === USER_ID));
  }

  const sorted = highlights.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return Promise.all(sorted.map(withImageUrl));
}

// =====================================================================
// Article fetching: web pages
// =====================================================================

// Turn relative links/images ("x4.png") into full URLs on the original site
function absolutizeUrls(html, baseUrl) {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);

  fixArticleUrls(document.body, baseUrl);
  return document.body.innerHTML;
}

// =====================================================================
// Article fetching: PDFs
// =====================================================================

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// PDFs don't store paragraphs, just lines of text at positions on a page.
// So we guess: a line much shorter than a "full" line, ending in punctuation, ends a paragraph.
function pdfTextToHtml(pages) {
  const lines = pages.flatMap((p) => p.split("\n")).map((l) => l.trim());
  const lengths = lines.filter(Boolean).map((l) => l.length).sort((a, b) => a - b);
  const fullLine = lengths[Math.floor(lengths.length * 0.75)] || 80;

  const paragraphs = [];
  let current = "";
  for (const line of lines) {
    if (!line) {
      if (current) paragraphs.push(current);
      current = "";
      continue;
    }
    if (/[a-z]-$/.test(current) && /^[a-z]/.test(line)) {
      current = current.slice(0, -1) + line; // re-join a word split across lines ("forma-" + "tion")
    } else {
      current = current ? `${current} ${line}` : line;
    }
    if (line.length < fullLine * 0.7 && /[.?!:"”)]$/.test(line)) {
      paragraphs.push(current);
      current = "";
    }
  }
  if (current) paragraphs.push(current);

  return paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n");
}

// Turn a downloaded PDF into the same shape Readability returns for web pages
async function pdfToArticle(buffer, url) {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: false }); // one string per page
  const pages = Array.isArray(text) ? text : [text];

  if (!pages.join("").trim()) {
    throw new Error("This PDF has no selectable text (it may be a scanned image)");
  }

  // Title: the PDF's own metadata if it has one, otherwise the file name
  let title = null;
  try {
    const { info } = await pdf.getMetadata();
    title = info?.Title?.trim() || null;
  } catch {}
  if (!title) {
    const fileName = decodeURIComponent(new URL(url).pathname.split("/").pop() || "PDF");
    title = fileName.replace(/\.pdf$/i, "");
  }

  const plain = pages.join(" ").replace(/\s+/g, " ").trim();
  return {
    title,
    content: pdfTextToHtml(pages),
    excerpt: plain.slice(0, 200),
    byline: null,
    siteName: new URL(url).hostname,
    format: "pdf",
  };
}

function looksLikePdf(url) {
  return /\.pdf($|\?)/i.test(url) || /arxiv\.org\/pdf\//i.test(url);
}

// =====================================================================
// Article fetching: download + decide what kind of file it is
// =====================================================================

async function fetchArticle(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; AnnotateApp/1.0)" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Page returned ${res.status}`);

  // What kind of file did the server send?
  const type = (res.headers.get("content-type") || "").toLowerCase();

  // PDF → extract its text, and keep the original file to save in S3
  if (type.includes("pdf") || (type.includes("octet-stream") && looksLikePdf(res.url))) {
    const arrayBuffer = await res.arrayBuffer();
    const original = Buffer.from(arrayBuffer);                         // a copy for S3
    const article = await pdfToArticle(arrayBuffer.slice(0), res.url); // PDF.js gets its own copy
    return { ...article, pdfBytes: original };
  }

  // Anything that isn't a web page → a clear error instead of garbage
  if (!type.includes("html") && !type.includes("xml")) {
    throw new Error(`This link isn't a web page or PDF (it's ${type.split(";")[0] || "an unknown file type"})`);
  }

  // Web page → Readability
  const html = await res.text();
  const { document } = parseHTML(html);

  const baseHref = document.querySelector("base")?.getAttribute("href");
  const baseUrl = baseHref ? new URL(baseHref, res.url).href : res.url;

  const article = new Readability(document).parse();
  if (!article) throw new Error("Couldn't find an article on that page");

  article.content = absolutizeUrls(article.content, baseUrl);
  return { ...article, format: "html" };
}

// Use the EC2 fetcher for web pages if it's running; PDFs are always handled here
async function getArticle(url) {
  if (!FETCHER_URL || looksLikePdf(url)) return fetchArticle(url);

  const res = await fetch(`${FETCHER_URL}/fetch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-fetcher-secret": FETCHER_SECRET },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Fetcher returned ${res.status}`);
  // The fetcher resolves src but not srcset, so finish the job here
  return { ...data, content: absolutizeUrls(data.content, url), format: "html" };
}



// =====================================================================
// Routes
// =====================================================================


export const handler = async (event) => {
  // API Gateway already verified the token; read who it belongs to
  const sub = event.requestContext?.authorizer?.jwt?.claims?.sub;
  if (!sub) return { statusCode: 401, body: JSON.stringify({ error: "Not signed in" }) };
  USER_ID = sub === LEGACY_OWNER_SUB ? "brianna" : sub;

  // The demo account can look around but not change anything
  if (sub === DEMO_SUB && event.requestContext.http.method !== "GET") {
    return json(403, { error: "The demo account is read-only. Sign up to save your own articles." });
  }

  if (event.routeKey === "GET /image-proxy") {
    const src = event.queryStringParameters?.src;
    if (!src) return { statusCode: 400, body: JSON.stringify({ error: "Missing src" }) };
    try {
      return await proxyImage(src);
    } catch (err) {
      return { statusCode: 400, body: JSON.stringify({ error: err.message }) };
    }
  }

  switch (event.routeKey) {

    // ---------- DOCUMENTS ----------

    // Save a link (or return it if it's already saved)
    case "POST /documents": {
      const { url: rawUrl } = JSON.parse(event.body || "{}");
      if (!rawUrl) return json(400, { error: "url is required" });

      // Clean up the URL so different links to the same article (tracking params, #section,
      // arXiv abs vs. pdf…) don't count as different articles
      try {
        new URL(rawUrl.trim());
      } catch {
        return json(400, { error: "That doesn't look like a valid link" });
      }
      const url = normalizeUrl(rawUrl);

      const docId = docIdFor(url);

      // Already saved (and not a failed attempt)? Return the existing one.
      const { Item: existing } = await db.send(new GetCommand({
        TableName: TABLE,
        Key: { userId: USER_ID, docId },
      }));
      if (existing && existing.status !== "failed") {
        return json(200, { ...existing, alreadySaved: true, duplicate: true });
      }

      // New, or a previous attempt failed: fetch it (this doubles as a retry)
      const item = {
        userId: USER_ID,
        docId,
        url,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };

      try {
        const article = await getArticle(url);

        // Backup check: the same article saved from a link that normalizes differently
        const sameTitle = await findByTitle(article.title, docId);
        if (sameTitle) {
          return json(200, { ...sameTitle, alreadySaved: true, duplicate: true });
        }

        const contentKey = `${USER_ID}/${docId}.html`;

        // 1. Save the readable text version
        await s3.send(new PutObjectCommand({
          Bucket: BUCKET,
          Key: contentKey,
          Body: article.content,
          ContentType: "text/html",
        }));

        // 2. PDFs: also save the original file, so it can be shown with its real layout
        let pdfKey;
        if (article.pdfBytes) {
          pdfKey = `${USER_ID}/${docId}.pdf`;
          await s3.send(new PutObjectCommand({
            Bucket: BUCKET,
            Key: pdfKey,
            Body: article.pdfBytes,
            ContentType: "application/pdf",
          }));
        }

        // 3. Record the details on the document
        Object.assign(item, {
          status: "ready",
          title: article.title,
          excerpt: article.excerpt,
          byline: article.byline,
          siteName: article.siteName,
          contentKey,
          pdfKey,
          format: article.format ?? "html",
          fetchedBy: FETCHER_URL && !looksLikePdf(url) ? "ec2" : "lambda",
        });
      } catch (err) {
        Object.assign(item, { status: "failed", error: err.message });
      }

      await db.send(new PutCommand({ TableName: TABLE, Item: item }));
      return json(201, item);
    }

    // List all my saved links
    case "GET /documents": {
      const result = await db.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "userId = :u",
        ExpressionAttributeValues: { ":u": USER_ID },
      }));
      return json(200, result.Items);
    }

    // Open one article: summary from DynamoDB + content from S3 (+ a PDF link for PDFs)
    case "GET /documents/{docId}": {
      const { docId } = event.pathParameters;
      const { Item } = await db.send(new GetCommand({
        TableName: TABLE,
        Key: { userId: USER_ID, docId },
      }));
      if (!Item) return json(404, { error: "not found" });

      let content = null;
      if (Item.contentKey) {
        const file = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: Item.contentKey }));
        content = await file.Body.transformToString();
      }

      // PDFs: a temporary link to the original file (the bucket itself stays private)
      let pdfUrl = null;
      if (Item.pdfKey) {
        pdfUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({
            Bucket: BUCKET,
            Key: Item.pdfKey,
            ResponseContentType: "application/pdf",
            ResponseContentDisposition: "inline", // show it in the browser instead of downloading
          }),
          { expiresIn: 3600 } // valid for 1 hour
        );
      }

      return json(200, { ...Item, content, pdfUrl });
    }

    // Delete an article and everything it owns
    case "DELETE /documents/{docId}": {
      const { docId } = event.pathParameters;
      const { Item } = await db.send(new GetCommand({
        TableName: TABLE,
        Key: { userId: USER_ID, docId },
      }));
      if (!Item) return json(404, { error: "not found" });

      // 1. The article's files in S3
      if (Item.contentKey) {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: Item.contentKey }));
      }
      if (Item.pdfKey) {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: Item.pdfKey }));
      }

      // 2. My highlights on it: their snip images, collection memberships, and the highlights
      //    themselves (other people who saved the same link keep theirs)
      for (const a of await myAnnotations(docId)) {
        await deleteMyAnnotation(docId, a.annotationId);
      }

      // 3. The document itself
      await db.send(new DeleteCommand({ TableName: TABLE, Key: { userId: USER_ID, docId } }));
      return json(204, null);
    }

    // ---------- SNIPS ----------

    // Step 1 of saving a snip: give the browser a short-lived link to upload one image directly to S3
    case "POST /documents/{docId}/snips/upload-url": {
      const { docId } = event.pathParameters;
      if (!(await getDocInfo(docId))) return json(404, { error: "article not found" });

      const imageKey = `${USER_ID}/snips/${docId}/${randomUUID()}.png`;
      const uploadUrl = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: BUCKET, Key: imageKey, ContentType: "image/png" }),
        { expiresIn: 300 } // 5 minutes is plenty for one upload
      );
      return json(200, { uploadUrl, imageKey });
    }

    // ---------- ANNOTATIONS (text highlights and snips) ----------

    // List highlights for one article (with image links for snips)
    case "GET /documents/{docId}/annotations": {
      const { docId } = event.pathParameters;
      return json(200, await Promise.all((await myAnnotations(docId)).map(withImageUrl)));
    }

    // Save a new highlight or snip, in any number of collections
    case "POST /documents/{docId}/annotations": {
      const { docId } = event.pathParameters;
      const body = JSON.parse(event.body || "{}");
      const { exact, prefix, suffix, note, collections, page, kind = "text", imageKey, rect } = body;

      // Text highlights need the highlighted text; snips need an uploaded image of THIS article
      if (kind === "text" && !exact) {
        return json(400, { error: "exact (the highlighted text) is required" });
      }
      if (kind === "area" && !imageKey?.startsWith(`${USER_ID}/snips/${docId}/`)) {
        return json(400, { error: "a snip needs an uploaded image" });
      }

      const docInfo = await getDocInfo(docId);
      if (!docInfo) return json(404, { error: "article not found" });

      const item = {
        docId,
        annotationId: randomUUID(),
        userId: USER_ID,
        kind,
        exact: exact ?? "",
        prefix: prefix ?? "",
        suffix: suffix ?? "",
        note: note ?? "",
        createdAt: new Date().toISOString(),
        ...docInfo,                                          // docTitle + docUrl
        ...(Number.isInteger(page) ? { page } : {}),         // which PDF page, if any
        ...(kind === "area" ? { imageKey, ...(rect ? { rect } : {}) } : {}),
      };

      const collectionIds = await resolveCollections(collections);
      if (collectionIds.length) item.collectionIds = new Set(collectionIds); // a DynamoDB string set

      await db.send(new PutCommand({ TableName: ANNOTATIONS_TABLE, Item: item }));
      await addToCollections(item, collectionIds);
      return json(201, await withImageUrl(item));
    }

    // Edit a highlight's note and/or its collections
    case "PATCH /documents/{docId}/annotations/{annotationId}": {
      const { docId, annotationId } = event.pathParameters;
      const body = JSON.parse(event.body || "{}");

      // Someone else's highlight looks exactly like a missing one, so IDs don't leak
      const existing = await getMyAnnotation(docId, annotationId);
      if (!existing) return json(404, { error: "not found" });

      const sets = [];
      const removes = [];
      const values = {};
      let added = [];
      let removed = [];

      if (body.note !== undefined) {
        sets.push("note = :note");
        values[":note"] = body.note;
      }

      if (body.collections !== undefined) {
        const newIds = await resolveCollections(body.collections);
        const oldIds = [...(existing.collectionIds ?? [])];
        added = newIds.filter((id) => !oldIds.includes(id));
        removed = oldIds.filter((id) => !newIds.includes(id));

        // DynamoDB doesn't allow empty sets, so "no collections" means removing the field
        if (newIds.length) {
          sets.push("collectionIds = :cids");
          values[":cids"] = new Set(newIds);
        } else {
          removes.push("collectionIds");
        }

        // Older highlights may not have the article title copied onto them yet
        if (!existing.docTitle) {
          const info = await getDocInfo(docId);
          if (info) {
            sets.push("docTitle = :dtitle", "docUrl = :durl");
            values[":dtitle"] = info.docTitle;
            values[":durl"] = info.docUrl;
          }
        }
      }

      if (!sets.length && !removes.length) return json(400, { error: "nothing to update" });

      let updateExpression = "";
      if (sets.length) updateExpression += `SET ${sets.join(", ")} `;
      if (removes.length) updateExpression += `REMOVE ${removes.join(", ")}`;

      let result;
      try {
        result = await db.send(new UpdateCommand({
          TableName: ANNOTATIONS_TABLE,
          Key: { docId, annotationId },
          UpdateExpression: updateExpression.trim(),
          ConditionExpression: "userId = :uid", // never update someone else's (or a deleted) highlight
          ExpressionAttributeValues: { ...values, ":uid": USER_ID },
          ReturnValues: "ALL_NEW",
        }));
      } catch (err) {
        if (err.name === "ConditionalCheckFailedException") return json(404, { error: "not found" });
        throw err;
      }

      // Keep the membership table in sync
      await addToCollections(result.Attributes, added);
      await removeFromCollections(annotationId, removed);

      return json(200, await withImageUrl(result.Attributes));
    }

    // Delete a highlight or snip (and its memberships and image)
    case "DELETE /documents/{docId}/annotations/{annotationId}": {
      const { docId, annotationId } = event.pathParameters;
      if (!(await deleteMyAnnotation(docId, annotationId))) return json(404, { error: "not found" });
      return json(204, null);
    }

    // ---------- COLLECTIONS ----------

    // Create an empty collection
    case "POST /collections": {
      const name = JSON.parse(event.body || "{}").name?.trim();
      if (!name) return json(400, { error: "name is required" });

      const all = await listCollections();
      if (all.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
        return json(409, { error: "You already have a collection with that name" });
      }
      return json(201, await resolveCollection(name));
    }

    // List my collections
    case "GET /collections": {
      const all = await listCollections();
      return json(200, all.sort((a, b) => a.name.localeCompare(b.name)));
    }

    // Every highlight in one collection, across all articles
    case "GET /collections/{collectionId}/highlights": {
      const { collectionId } = event.pathParameters;
      return json(200, await collectionHighlights(collectionId));
    }

    // Rename: only the collection row changes, since highlights store IDs, not names
    case "PATCH /collections/{collectionId}": {
      const { collectionId } = event.pathParameters;
      const name = JSON.parse(event.body || "{}").name?.trim();
      if (!name) return json(400, { error: "name is required" });

      const all = await listCollections();
      if (!all.some((c) => c.collectionId === collectionId)) return json(404, { error: "not found" });
      if (all.some((c) => c.collectionId !== collectionId && c.name.toLowerCase() === name.toLowerCase())) {
        return json(409, { error: "You already have a collection with that name" });
      }

      await db.send(new UpdateCommand({
        TableName: COLLECTIONS_TABLE,
        Key: { userId: USER_ID, collectionId },
        UpdateExpression: "SET #n = :name",
        ExpressionAttributeNames: { "#n": "name" }, // "name" is a DynamoDB reserved word
        ExpressionAttributeValues: { ":name": name },
      }));

      return json(200, { collectionId, name });
    }

    // Delete a collection (its highlights stay on their articles)
    case "DELETE /collections/{collectionId}": {
      const { collectionId } = event.pathParameters;

      for (const m of await collectionMembers(collectionId)) {
        // 1. Take this collection off the highlight's list (only if the highlight still exists)
        try {
          await db.send(new UpdateCommand({
            TableName: ANNOTATIONS_TABLE,
            Key: { docId: m.docId, annotationId: m.annotationId },
            UpdateExpression: "DELETE collectionIds :c", // removes one value from a set
            ConditionExpression: "userId = :u", // only if it still exists and is mine
            ExpressionAttributeValues: { ":c": new Set([collectionId]), ":u": USER_ID },
          }));
        } catch (err) {
          if (err.name !== "ConditionalCheckFailedException") throw err;
        }
        // 2. Remove the membership row
        await db.send(new DeleteCommand({
          TableName: COLLECTION_ITEMS_TABLE,
          Key: { collectionKey: m.collectionKey, annotationId: m.annotationId },
        }));
      }

      // 3. The collection itself
      await db.send(new DeleteCommand({
        TableName: COLLECTIONS_TABLE,
        Key: { userId: USER_ID, collectionId },
      }));
      return json(204, null);
    }

    default:
      return json(404, { error: "route not found" });
  }
};