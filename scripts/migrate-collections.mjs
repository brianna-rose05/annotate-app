// One-time migration: move each highlight's single collection into the new many-to-many structure
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const ANNOTATIONS = "annotate-app-annotations";
const COLLECTION_ITEMS = "annotate-app-collection-items";

// Scan reads the whole table. Fine for a small one-time job, too slow for normal app requests.
const { Items } = await db.send(new ScanCommand({
  TableName: ANNOTATIONS,
  FilterExpression: "attribute_exists(collectionId)",
}));
console.log(`Found ${Items.length} highlight(s) to migrate`);

for (const a of Items) {
  // 1. Add the membership row
  await db.send(new PutCommand({
    TableName: COLLECTION_ITEMS,
    Item: {
      collectionKey: a.collectionKey,
      annotationId: a.annotationId,
      docId: a.docId,
      createdAt: a.createdAt,
    },
  }));

  // 2. Move the ID into the new set, and remove the old single-collection fields
  await db.send(new UpdateCommand({
    TableName: ANNOTATIONS,
    Key: { docId: a.docId, annotationId: a.annotationId },
    UpdateExpression: "ADD collectionIds :c REMOVE collectionId, collectionName, collectionKey",
    ExpressionAttributeValues: { ":c": new Set([a.collectionId]) },
  }));

  console.log(`  ✓ "${a.exact.slice(0, 40)}" → ${a.collectionId}`);
}

console.log("Done");