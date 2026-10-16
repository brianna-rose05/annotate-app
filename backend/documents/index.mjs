import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  GetCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { randomUUID } from "node:crypto";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const TABLE = process.env.TABLE_NAME;
const BUCKET = process.env.CONTENT_BUCKET;
const ANNOTATIONS_TABLE = process.env.ANNOTATIONS_TABLE;
const USER_ID = "brianna"; // placeholder until login is added

const json = (statusCode, data) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});

// Download a page and pull out just the article
async function fetchArticle(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; AnnotateApp/1.0)" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Page returned ${res.status}`);

  const html = await res.text();
  const { document } = parseHTML(html);
  const article = new Readability(document).parse();
  if (!article) throw new Error("Couldn't find an article on that page");
  return article;
}

export const handler = async (event) => {
  switch (event.routeKey) {

    // ---------- DOCUMENTS ----------

    // Save a link: fetch it, store the article in S3, store the summary in DynamoDB
    case "POST /documents": {
      const { url } = JSON.parse(event.body || "{}");
      if (!url) return json(400, { error: "url is required" });

      const docId = randomUUID();
      const item = { userId: USER_ID, docId, url, createdAt: new Date().toISOString() };

      try {
        const article = await fetchArticle(url);
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

    // Open one article: summary from DynamoDB + content from S3
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

    // ---------- ANNOTATIONS ----------

    // List highlights for one article
    case "GET /documents/{docId}/annotations": {
      const { docId } = event.pathParameters;
      const result = await db.send(new QueryCommand({
        TableName: ANNOTATIONS_TABLE,
        KeyConditionExpression: "docId = :d",
        ExpressionAttributeValues: { ":d": docId },
      }));
      return json(200, result.Items);
    }

    // Save a new highlight
    case "POST /documents/{docId}/annotations": {
      const { docId } = event.pathParameters;
      const { exact, prefix, suffix, note } = JSON.parse(event.body || "{}");
      if (!exact) return json(400, { error: "exact (the highlighted text) is required" });

      const item = {
        docId,
        annotationId: randomUUID(),
        userId: USER_ID,
        exact,
        prefix: prefix ?? "",
        suffix: suffix ?? "",
        note: note ?? "",
        createdAt: new Date().toISOString(),
      };
      await db.send(new PutCommand({ TableName: ANNOTATIONS_TABLE, Item: item }));
      return json(201, item);
    }

    // Remove a highlight
    case "DELETE /documents/{docId}/annotations/{annotationId}": {
      const { docId, annotationId } = event.pathParameters;
      await db.send(new DeleteCommand({
        TableName: ANNOTATIONS_TABLE,
        Key: { docId, annotationId },
      }));
      return json(204, null);
    }

    default:
      return json(404, { error: "route not found" });
  }
};