import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
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
const FETCHER_URL = process.env.FETCHER_URL;
const FETCHER_SECRET = process.env.FETCHER_SECRET;
const USER_ID = "brianna"; // placeholder until login is added

const json = (statusCode, data) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});

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

// Create the collection if it doesn't exist yet (keeps the original name and date if it does)
async function ensureCollection(collectionId, name) {
  try {
    await db.send(new PutCommand({
      TableName: COLLECTIONS_TABLE,
      Item: { userId: USER_ID, collectionId, name, createdAt: new Date().toISOString() },
      ConditionExpression: "attribute_not_exists(collectionId)",
    }));
  } catch (err) {
    if (err.name !== "ConditionalCheckFailedException") throw err; // already exists = fine
  }
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

// Download a page and pull out just the article
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

// Use the EC2 fetcher if it's running; otherwise fetch inside the Lambda
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
      return json(200, result.Items);
    }

    // Save a new highlight (optionally into a collection)
    case "POST /documents/{docId}/annotations": {
      const { docId } = event.pathParameters;
      const { exact, prefix, suffix, note, collection } = JSON.parse(event.body || "{}");
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

      const collectionId = slugify(collection);
      if (collectionId) {
        await ensureCollection(collectionId, collection.trim());
        Object.assign(item, {
          collectionId,
          collectionName: collection.trim(),
          collectionKey: `${USER_ID}#${collectionId}`, // what the byCollection index looks up
        });
      }

      await db.send(new PutCommand({ TableName: ANNOTATIONS_TABLE, Item: item }));
      return json(201, item);
    }

    // Edit a highlight's note and/or collection
    case "PATCH /documents/{docId}/annotations/{annotationId}": {
      const { docId, annotationId } = event.pathParameters;
      const body = JSON.parse(event.body || "{}");

      const sets = [];
      const removes = [];
      const values = {};

      if (body.note !== undefined) {
        sets.push("note = :note");
        values[":note"] = body.note;
      }

      if (body.collection !== undefined) {
        const collectionId = slugify(body.collection);
        if (collectionId) {
          // Move into a collection
          await ensureCollection(collectionId, body.collection.trim());
          const docInfo = await getDocInfo(docId);
          if (!docInfo) return json(404, { error: "article not found" });
          const { docTitle, docUrl } = docInfo;
          sets.push(
            "collectionId = :cid",
            "collectionName = :cname",
            "collectionKey = :ckey",
            "docTitle = :dtitle",
            "docUrl = :durl"
          );
          Object.assign(values, {
            ":cid": collectionId,
            ":cname": body.collection.trim(),
            ":ckey": `${USER_ID}#${collectionId}`,
            ":dtitle": docTitle,
            ":durl": docUrl,
          });
        } else {
          // Empty name = take it out of its collection (it disappears from the index)
          removes.push("collectionId", "collectionName", "collectionKey");
        }
      }

      if (!sets.length && !removes.length) return json(400, { error: "nothing to update" });

      let updateExpression = "";
      if (sets.length) updateExpression += `SET ${sets.join(", ")} `;
      if (removes.length) updateExpression += `REMOVE ${removes.join(", ")}`;

      try {
        const result = await db.send(new UpdateCommand({
          TableName: ANNOTATIONS_TABLE,
          Key: { docId, annotationId },
          UpdateExpression: updateExpression.trim(),
          ConditionExpression: "attribute_exists(annotationId)",
          ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
          ReturnValues: "ALL_NEW",
        }));
        return json(200, result.Attributes);
      } catch (err) {
        if (err.name === "ConditionalCheckFailedException") return json(404, { error: "not found" });
        throw err;
      }
    }

    case "DELETE /documents/{docId}/annotations/{annotationId}": {
      const { docId, annotationId } = event.pathParameters;
      await db.send(new DeleteCommand({
        TableName: ANNOTATIONS_TABLE,
        Key: { docId, annotationId },
      }));
      return json(204, null);
    }

    // ---------- COLLECTIONS ----------

    // List my collections
    case "GET /collections": {
      const result = await db.send(new QueryCommand({
        TableName: COLLECTIONS_TABLE,
        KeyConditionExpression: "userId = :u",
        ExpressionAttributeValues: { ":u": USER_ID },
      }));
      const collections = result.Items.sort((a, b) => a.name.localeCompare(b.name));
      return json(200, collections);
    }

    // Every highlight in one collection, across all articles, newest first
    case "GET /collections/{collectionId}/highlights": {
      const { collectionId } = event.pathParameters;
      const result = await db.send(new QueryCommand({
        TableName: ANNOTATIONS_TABLE,
        IndexName: "byCollection", // ← use the GSI instead of the main table
        KeyConditionExpression: "collectionKey = :k",
        ExpressionAttributeValues: { ":k": `${USER_ID}#${collectionId}` },
        ScanIndexForward: false, // newest first (sorted by the index's createdAt)
      }));
      return json(200, result.Items);
    }

    default:
      return json(404, { error: "route not found" });
  }
};