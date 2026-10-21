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
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { randomUUID, createHash } from "node:crypto";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const TABLE = process.env.TABLE_NAME;
const BUCKET = process.env.CONTENT_BUCKET;
const ANNOTATIONS_TABLE = process.env.ANNOTATIONS_TABLE;
const COLLECTIONS_TABLE = process.env.COLLECTIONS_TABLE;
const COLLECTION_ITEMS_TABLE = process.env.COLLECTION_ITEMS_TABLE;
const FETCHER_URL = process.env.FETCHER_URL;
const FETCHER_SECRET = process.env.FETCHER_SECRET;
const USER_ID = "brianna"; // placeholder until login is added

const json = (statusCode, data) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});

// ---------- General helpers ----------

// Same URL → same ID, so saving a link twice doesn't create a duplicate
function docIdFor(url) {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
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

// The article's title and URL, copied onto each highlight. Returns null if the article doesn't exist.
async function getDocInfo(docId) {
  const { Item } = await db.send(new GetCommand({
    TableName: TABLE,
    Key: { userId: USER_ID, docId },
  }));
  if (!Item) return null;
  return { docTitle: Item.title ?? Item.url, docUrl: Item.url };
}

// ---------- Collection helpers ----------

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

// Every highlight in a collection, newest first
async function collectionHighlights(collectionId) {
  const members = await collectionMembers(collectionId);
  const highlights = [];

  // BatchGet fetches up to 100 items per request
  for (let i = 0; i < members.length; i += 100) {
    const keys = members.slice(i, i + 100).map((m) => ({ docId: m.docId, annotationId: m.annotationId }));
    const res = await db.send(new BatchGetCommand({
      RequestItems: { [ANNOTATIONS_TABLE]: { Keys: keys } },
    }));
    highlights.push(...res.Responses[ANNOTATIONS_TABLE]);
  }

  return highlights.map(toClient).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ---------- Article fetching ----------

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

async function getArticle(url) {
  if (!FETCHER_URL) return fetchArticle(url);

  const res = await fetch(`${FETCHER_URL}/fetch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-fetcher-secret": FETCHER_SECRET },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(12000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Fetcher returned ${res.status}`);
  return data;
}

// ---------- Routes ----------

export const handler = async (event) => {
  switch (event.routeKey) {

    // ---------- DOCUMENTS ----------

    case "POST /documents": {
      const { url: rawUrl } = JSON.parse(event.body || "{}");
      if (!rawUrl) return json(400, { error: "url is required" });

      let url;
      try {
        const parsed = new URL(rawUrl.trim());
        parsed.hash = "";
        url = parsed.href;
      } catch {
        return json(400, { error: "That doesn't look like a valid link" });
      }

      const docId = docIdFor(url);

      const { Item: existing } = await db.send(new GetCommand({
        TableName: TABLE,
        Key: { userId: USER_ID, docId },
      }));
      if (existing?.status === "ready") {
        return json(200, { ...existing, alreadySaved: true });
      }

      const item = {
        userId: USER_ID,
        docId,
        url,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };

      try {
        const article = await getArticle(url);
        const contentKey = `${USER_ID}/${docId}.html`;

        await s3.send(new PutObjectCommand({
          Bucket: BUCKET,
          Key: contentKey,
          Body: article.content,
          ContentType: "text/html",
        }));

        Object.assign(item, {
          status: "ready",
          title: article.title,
          excerpt: article.excerpt,
          byline: article.byline,
          siteName: article.siteName,
          contentKey,
          fetchedBy: FETCHER_URL ? "ec2" : "lambda",
        });
      } catch (err) {
        Object.assign(item, { status: "failed", error: err.message });
      }

      await db.send(new PutCommand({ TableName: TABLE, Item: item }));
      return json(201, item);
    }

    case "GET /documents": {
      const result = await db.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "userId = :u",
        ExpressionAttributeValues: { ":u": USER_ID },
      }));
      return json(200, result.Items);
    }

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
      return json(200, { ...Item, content });
    }

    // Delete an article and everything it owns
    case "DELETE /documents/{docId}": {
      const { docId } = event.pathParameters;
      const { Item } = await db.send(new GetCommand({
        TableName: TABLE,
        Key: { userId: USER_ID, docId },
      }));
      if (!Item) return json(404, { error: "not found" });

      if (Item.contentKey) {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: Item.contentKey }));
      }

      const annotations = await db.send(new QueryCommand({
        TableName: ANNOTATIONS_TABLE,
        KeyConditionExpression: "docId = :d",
        ExpressionAttributeValues: { ":d": docId },
      }));
      for (const a of annotations.Items) {
        await removeFromCollections(a.annotationId, [...(a.collectionIds ?? [])]);
        await db.send(new DeleteCommand({
          TableName: ANNOTATIONS_TABLE,
          Key: { docId, annotationId: a.annotationId },
        }));
      }

      await db.send(new DeleteCommand({ TableName: TABLE, Key: { userId: USER_ID, docId } }));
      return json(204, null);
    }

    // ---------- ANNOTATIONS ----------

    case "GET /documents/{docId}/annotations": {
      const { docId } = event.pathParameters;
      const result = await db.send(new QueryCommand({
        TableName: ANNOTATIONS_TABLE,
        KeyConditionExpression: "docId = :d",
        ExpressionAttributeValues: { ":d": docId },
      }));
      return json(200, result.Items.map(toClient));
    }

    // Save a new highlight, in any number of collections
    case "POST /documents/{docId}/annotations": {
      const { docId } = event.pathParameters;
      const { exact, prefix, suffix, note, collections } = JSON.parse(event.body || "{}");
      if (!exact) return json(400, { error: "exact (the highlighted text) is required" });

      const docInfo = await getDocInfo(docId);
      if (!docInfo) return json(404, { error: "article not found" });

      const item = {
        docId,
        annotationId: randomUUID(),
        userId: USER_ID,
        exact,
        prefix: prefix ?? "",
        suffix: suffix ?? "",
        note: note ?? "",
        createdAt: new Date().toISOString(),
        ...docInfo, // docTitle + docUrl
      };

      const collectionIds = await resolveCollections(collections);
      if (collectionIds.length) item.collectionIds = new Set(collectionIds); // a DynamoDB string set

      await db.send(new PutCommand({ TableName: ANNOTATIONS_TABLE, Item: item }));
      await addToCollections(item, collectionIds);
      return json(201, toClient(item));
    }

    // Edit a highlight's note and/or its collections
    case "PATCH /documents/{docId}/annotations/{annotationId}": {
      const { docId, annotationId } = event.pathParameters;
      const body = JSON.parse(event.body || "{}");

      const { Item: existing } = await db.send(new GetCommand({
        TableName: ANNOTATIONS_TABLE,
        Key: { docId, annotationId },
      }));
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

      const result = await db.send(new UpdateCommand({
        TableName: ANNOTATIONS_TABLE,
        Key: { docId, annotationId },
        UpdateExpression: updateExpression.trim(),
        ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
        ReturnValues: "ALL_NEW",
      }));

      // Keep the membership table in sync
      await addToCollections(result.Attributes, added);
      await removeFromCollections(annotationId, removed);

      return json(200, toClient(result.Attributes));
    }

    // Delete a highlight (and its memberships)
    case "DELETE /documents/{docId}/annotations/{annotationId}": {
      const { docId, annotationId } = event.pathParameters;
      const { Item } = await db.send(new GetCommand({
        TableName: ANNOTATIONS_TABLE,
        Key: { docId, annotationId },
      }));
      if (Item) await removeFromCollections(annotationId, [...(Item.collectionIds ?? [])]);

      await db.send(new DeleteCommand({
        TableName: ANNOTATIONS_TABLE,
        Key: { docId, annotationId },
      }));
      return json(204, null);
    }

    // ---------- COLLECTIONS ----------

    case "POST /collections": {
      const name = JSON.parse(event.body || "{}").name?.trim();
      if (!name) return json(400, { error: "name is required" });

      const all = await listCollections();
      if (all.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
        return json(409, { error: "You already have a collection with that name" });
      }
      return json(201, await resolveCollection(name));
    }

    case "GET /collections": {
      const all = await listCollections();
      return json(200, all.sort((a, b) => a.name.localeCompare(b.name)));
    }

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
            ConditionExpression: "attribute_exists(annotationId)",
            ExpressionAttributeValues: { ":c": new Set([collectionId]) },
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