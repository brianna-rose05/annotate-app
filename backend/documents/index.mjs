import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { randomUUID } from "node:crypto";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const TABLE = process.env.TABLE_NAME;
const BUCKET = process.env.CONTENT_BUCKET;
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
    signal: AbortSignal.timeout(10000), // give up after 10 seconds
  });
  if (!res.ok) throw new Error(`Page returned ${res.status}`);

  const html = await res.text();
  const { document } = parseHTML(html);
  const article = new Readability(document).parse();
  if (!article) throw new Error("Couldn't find an article on that page");
  return article; // { title, content, excerpt, byline, siteName, ... }
}

export const handler = async (event) => {
  // routeKey tells us which route was called, e.g. "POST /documents"
  switch (event.routeKey) {

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
        // Still save the link, but mark it failed so the app can show why
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

    default:
      return json(404, { error: "route not found" });
  }
};