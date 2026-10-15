import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE_NAME;
const USER_ID = "brianna"; // placeholder until login is added

// Helper to build a JSON response
const json = (statusCode, data) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});

export const handler = async (event) => {
  const method = event.requestContext.http.method;

  // POST /documents → save a new link
  if (method === "POST") {
    const { url } = JSON.parse(event.body || "{}");
    if (!url) return json(400, { error: "url is required" });

    const item = {
      userId: USER_ID,
      docId: randomUUID(),
      url,
      createdAt: new Date().toISOString(),
    };
    await db.send(new PutCommand({ TableName: TABLE, Item: item }));
    return json(201, item);
  }

  // GET /documents → list all of my saved links
  if (method === "GET") {
    const result = await db.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "userId = :u",
      ExpressionAttributeValues: { ":u": USER_ID },
    }));
    return json(200, result.Items);
  }

  return json(405, { error: "method not allowed" });
};