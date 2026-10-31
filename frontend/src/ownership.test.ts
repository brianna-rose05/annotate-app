// Two users save the same article (so it gets the same docId) and must never be able to see,
// change, or delete each other's highlights, notes, snips, or collections.
// Runs the real backend handler against in-memory DynamoDB and S3 fakes.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------- In-memory DynamoDB ----------
type Item = Record<string, unknown>;
type Vals = Record<string, unknown>;

const KEYS: Record<string, [string, string]> = {
  documents: ["userId", "docId"],
  annotations: ["docId", "annotationId"],
  collections: ["userId", "collectionId"],
  items: ["collectionKey", "annotationId"],
};
const tables: Record<string, Map<string, Item>> = {};
const keyOf = (table: string, k: Item) => KEYS[table].map((f) => String(k[f])).join("|");
const conditionFailed = () =>
  Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });

// Only the expression forms the backend uses: "a = :v", "attribute_exists(a)", joined by AND
function matches(expr: string | undefined, item: Item | undefined, vals: Vals = {}, names: Record<string, string> = {}) {
  if (!expr) return true;
  return expr.split(/\s+AND\s+/).every((clause) => {
    const exists = clause.match(/^attribute_exists\((\w+)\)$/);
    if (exists) return item?.[exists[1]] !== undefined;
    const [, field, value] = clause.match(/^(#?\w+)\s*=\s*(:\w+)$/)!;
    return item !== undefined && item[names[field] ?? field] === vals[value];
  });
}

function applyUpdate(item: Item, expr: string, vals: Vals, names: Record<string, string> = {}) {
  const parts = expr.split(/\b(?=SET |REMOVE |DELETE )/);
  for (const part of parts) {
    const [action, rest] = [part.slice(0, part.indexOf(" ")), part.slice(part.indexOf(" ") + 1)];
    for (const clause of rest.split(",").map((c) => c.trim()).filter(Boolean)) {
      if (action === "SET") {
        const [field, value] = clause.split(/\s*=\s*/);
        item[names[field] ?? field] = vals[value];
      } else if (action === "REMOVE") {
        delete item[clause];
      } else if (action === "DELETE") {
        const [field, value] = clause.split(/\s+/);
        const set = new Set(item[field] as Set<string>);
        for (const v of vals[value] as Set<string>) set.delete(v);
        if (set.size) item[field] = set;
        else delete item[field];
      }
    }
  }
}

const tableName = (name: string) => name.replace(/^t-/, "");

class Cmd {
  input: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  constructor(input: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
    this.input = input;
  }
}
class PutCommand extends Cmd {}
class GetCommand extends Cmd {}
class QueryCommand extends Cmd {}
class DeleteCommand extends Cmd {}
class UpdateCommand extends Cmd {}
class BatchGetCommand extends Cmd {}

const clone = <T,>(x: T): T => structuredClone(x);

async function dynamoSend(cmd: Cmd) {
  const i = cmd.input;
  if (cmd instanceof BatchGetCommand) {
    const Responses: Record<string, Item[]> = {};
    for (const [name, { Keys }] of Object.entries(i.RequestItems as Record<string, { Keys: Item[] }>)) {
      const t = tableName(name);
      Responses[name] = Keys.map((k) => tables[t].get(keyOf(t, k))).filter(Boolean).map(clone) as Item[];
    }
    return { Responses };
  }
  const t = tableName(i.TableName);
  const table = tables[t];
  if (cmd instanceof PutCommand) {
    table.set(keyOf(t, i.Item), clone(i.Item));
    return {};
  }
  if (cmd instanceof GetCommand) {
    const item = table.get(keyOf(t, i.Key));
    return { Item: item && clone(item) };
  }
  if (cmd instanceof QueryCommand) {
    const items = [...table.values()].filter(
      (it) =>
        matches(i.KeyConditionExpression, it, i.ExpressionAttributeValues) &&
        matches(i.FilterExpression, it, i.ExpressionAttributeValues),
    );
    return { Items: items.map(clone) };
  }
  const existing = table.get(keyOf(t, i.Key));
  if (!matches(i.ConditionExpression, existing, i.ExpressionAttributeValues, i.ExpressionAttributeNames)) {
    throw conditionFailed();
  }
  if (cmd instanceof DeleteCommand) {
    table.delete(keyOf(t, i.Key));
    return { Attributes: i.ReturnValues === "ALL_OLD" && existing ? clone(existing) : undefined };
  }
  if (cmd instanceof UpdateCommand) {
    const item = existing ?? { ...i.Key };
    applyUpdate(item, i.UpdateExpression, i.ExpressionAttributeValues ?? {}, i.ExpressionAttributeNames);
    table.set(keyOf(t, i.Key), item);
    return { Attributes: clone(item) };
  }
  throw new Error(`fake DynamoDB: unsupported ${cmd.constructor.name}`);
}

// ---------- In-memory S3 ----------
const objects = new Map<string, string>();

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: dynamoSend }) },
  PutCommand, GetCommand, QueryCommand, DeleteCommand, UpdateCommand, BatchGetCommand,
}));
// The backend loads its own installed copies of these two, so mock those exact packages
vi.mock("../../backend/documents/node_modules/@aws-sdk/client-s3", () => {
  class S3Cmd extends Cmd {}
  class PutObjectCommand extends S3Cmd {}
  class GetObjectCommand extends S3Cmd {}
  class DeleteObjectCommand extends S3Cmd {}
  return {
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    S3Client: class {
      async send(cmd: Cmd) {
        const key = cmd.input.Key as string;
        if (cmd instanceof PutObjectCommand) objects.set(key, String(cmd.input.Body));
        if (cmd instanceof DeleteObjectCommand) objects.delete(key);
        if (cmd instanceof GetObjectCommand) {
          return { Body: { transformToString: async () => objects.get(key) ?? "" } };
        }
        return {};
      }
    },
  };
});
vi.mock("../../backend/documents/node_modules/@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: async (_s3: unknown, cmd: Cmd) => `https://signed.example/${cmd.input.Key}`,
}));

// ---------- The real handler ----------
type Handler = (event: unknown) => Promise<{ statusCode: number; body: string | null }>;
let handler: Handler;

const ALICE = "alice-sub";
const BOB = "bob-sub";
const LEGACY_SUB = "4498f438-80c1-7011-ab5b-affb6371d0e8"; // maps to userId "brianna"
const DEMO_SUB = "34a8e4b8-c071-70f9-5413-db7ec45277fe";
const ARTICLE_URL = "https://example.com/great-essay";

async function call(sub: string, method: string, path: string, params: Record<string, string> = {}, body?: unknown) {
  const res = await handler({
    routeKey: `${method} ${path}`,
    pathParameters: params,
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: { http: { method }, authorizer: { jwt: { claims: { sub } } } },
  });
  return { status: res.statusCode, data: res.body ? JSON.parse(res.body) : null };
}

const saveArticle = (sub: string) => call(sub, "POST", "/documents", {}, { url: ARTICLE_URL });
const listHighlights = async (sub: string, docId: string) =>
  (await call(sub, "GET", "/documents/{docId}/annotations", { docId })).data as Item[];
const highlight = (sub: string, docId: string, body: Item) =>
  call(sub, "POST", "/documents/{docId}/annotations", { docId }, body);
const patchHighlight = (sub: string, docId: string, annotationId: string, body: Item) =>
  call(sub, "PATCH", "/documents/{docId}/annotations/{annotationId}", { docId, annotationId }, body);
const deleteHighlight = (sub: string, docId: string, annotationId: string) =>
  call(sub, "DELETE", "/documents/{docId}/annotations/{annotationId}", { docId, annotationId });
const collectionHighlights = async (sub: string, collectionId: string) =>
  (await call(sub, "GET", "/collections/{collectionId}/highlights", { collectionId })).data as Item[];

async function addSnip(sub: string, docId: string) {
  const { data } = await call(sub, "POST", "/documents/{docId}/snips/upload-url", { docId });
  objects.set(data.imageKey, "png bytes"); // the browser's direct upload
  return highlight(sub, docId, { kind: "area", imageKey: data.imageKey, note: `${sub} snip` });
}

const ARTICLE_HTML = `<!doctype html><html><head><title>A Great Essay</title></head><body><article>
  <h1>A Great Essay</h1>
  ${"<p>The quick brown fox jumps over the lazy dog, again and again, to make this a long enough article for Readability to keep. </p>".repeat(12)}
</article></body></html>`;

// Hoisted above the imports, so it's in place before any AWS client is created
vi.hoisted(() => {
  // (The app's tsconfig has no Node types, so reach process through globalThis)
  const { process } = globalThis as unknown as { process: { env: Record<string, string> } };
  // Safety net: if any AWS call ever slipped past the fakes, it fails here instead of
  // reaching a real account with the developer's credentials
  Object.assign(process.env, {
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    AWS_SESSION_TOKEN: "",
    AWS_PROFILE: "",
    AWS_REGION: "us-east-1",
    AWS_ENDPOINT_URL: "http://127.0.0.1:9",
  });
});

beforeAll(async () => {
  const { process } = globalThis as unknown as { process: { env: Record<string, string> } };
  Object.assign(process.env, {
    TABLE_NAME: "t-documents",
    ANNOTATIONS_TABLE: "t-annotations",
    COLLECTIONS_TABLE: "t-collections",
    COLLECTION_ITEMS_TABLE: "t-items",
    CONTENT_BUCKET: "content",
    FETCHER_URL: "",
  });
  vi.stubGlobal("fetch", async (url: string) => {
    const res = new Response(ARTICLE_HTML, { headers: { "content-type": "text/html" } });
    Object.defineProperty(res, "url", { value: url });
    return res;
  });
  // @ts-expect-error -- the Lambda handler is plain JavaScript with no type declarations
  ({ handler } = await import("../../backend/documents/index.mjs"));
});

beforeEach(() => {
  for (const t of Object.keys(KEYS)) tables[t] = new Map();
  objects.clear();
});

// Both users save the same link, then each adds a highlight (with a note and the same-named
// collection) and a snip
async function twoUsersOnOneArticle() {
  const a = await saveArticle(ALICE);
  const b = await saveArticle(BOB);
  expect(a.status).toBe(201);
  expect(b.status).toBe(201);
  expect([a.data.status, b.data.status]).toEqual(["ready", "ready"]); // fetched and stored (in the fake S3)
  expect(a.data.docId).toBe(b.data.docId); // same link → same docId: the risky case
  const docId = a.data.docId as string;

  const aliceHl = (await highlight(ALICE, docId, {
    exact: "quick brown fox", prefix: "The ", suffix: " jumps", note: "alice's private note", collections: ["Research"],
  })).data;
  const bobHl = (await highlight(BOB, docId, {
    exact: "lazy dog", prefix: "the ", suffix: ", again", note: "bob's note", collections: ["Research"],
  })).data;
  const aliceSnip = (await addSnip(ALICE, docId)).data;
  const bobSnip = (await addSnip(BOB, docId)).data;
  return { docId, aliceHl, bobHl, aliceSnip, bobSnip };
}

const ids = (items: Item[]) => items.map((i) => i.annotationId).sort();

describe("two users who saved the same article", () => {
  it("each only sees their own highlights, notes, and snips", async () => {
    const { docId, aliceHl, bobHl, aliceSnip, bobSnip } = await twoUsersOnOneArticle();

    const aliceSees = await listHighlights(ALICE, docId);
    expect(ids(aliceSees)).toEqual(ids([aliceHl, aliceSnip]));
    expect(JSON.stringify(aliceSees)).not.toContain("bob");

    const bobSees = await listHighlights(BOB, docId);
    expect(ids(bobSees)).toEqual(ids([bobHl, bobSnip]));
    expect(JSON.stringify(bobSees)).not.toContain("alice");
  });

  it("can't edit another user's note or collections (404, unchanged, no membership added)", async () => {
    const { docId, aliceHl } = await twoUsersOnOneArticle();

    const note = await patchHighlight(BOB, docId, aliceHl.annotationId, { note: "hijacked" });
    expect(note.status).toBe(404);
    const cols = await patchHighlight(BOB, docId, aliceHl.annotationId, { collections: ["Stolen"] });
    expect(cols.status).toBe(404);

    const [stillAlices] = (await listHighlights(ALICE, docId)).filter((h) => h.annotationId === aliceHl.annotationId);
    expect(stillAlices.note).toBe("alice's private note");
    expect(stillAlices.collectionIds).toEqual(["research"]);
    expect((await call(BOB, "GET", "/collections")).data.map((c: Item) => c.name)).not.toContain("Stolen");
    expect(await collectionHighlights(BOB, "research")).toHaveLength(1); // only Bob's own
  });

  it("can't delete another user's highlight or snip (404, nothing removed)", async () => {
    const { docId, aliceHl, aliceSnip } = await twoUsersOnOneArticle();

    expect((await deleteHighlight(BOB, docId, aliceHl.annotationId)).status).toBe(404);
    expect((await deleteHighlight(BOB, docId, aliceSnip.annotationId)).status).toBe(404);

    expect(ids(await listHighlights(ALICE, docId))).toEqual(ids([aliceHl, aliceSnip]));
    expect(objects.has(aliceSnip.imageKey)).toBe(true);
    expect(await collectionHighlights(ALICE, "research")).toHaveLength(1);
  });

  it("someone else's highlight looks the same as a missing one", async () => {
    const { docId, aliceHl } = await twoUsersOnOneArticle();
    const missing = await deleteHighlight(BOB, docId, "no-such-id");
    const someoneElses = await deleteHighlight(BOB, docId, aliceHl.annotationId);
    expect(someoneElses).toEqual(missing);
    expect(await patchHighlight(BOB, docId, aliceHl.annotationId, { note: "x" }))
      .toEqual(await patchHighlight(BOB, docId, "no-such-id", { note: "x" }));
  });

  it("deleting the article removes only your own highlights, snips, memberships, and files", async () => {
    const { docId, aliceHl, aliceSnip, bobSnip } = await twoUsersOnOneArticle();

    expect((await call(BOB, "DELETE", "/documents/{docId}", { docId })).status).toBe(204);

    // Bob's things are gone
    expect(await listHighlights(BOB, docId)).toEqual([]);
    expect(objects.has(bobSnip.imageKey)).toBe(false);
    expect(await collectionHighlights(BOB, "research")).toEqual([]);
    expect((await call(BOB, "GET", "/documents/{docId}", { docId })).status).toBe(404);

    // Alice's are untouched, including her copy of the article and its stored HTML
    expect(ids(await listHighlights(ALICE, docId))).toEqual(ids([aliceHl, aliceSnip]));
    expect(objects.has(aliceSnip.imageKey)).toBe(true);
    expect(ids(await collectionHighlights(ALICE, "research"))).toEqual([aliceHl.annotationId]);
    const aliceDoc = await call(ALICE, "GET", "/documents/{docId}", { docId });
    expect(aliceDoc.status).toBe(200);
    expect(aliceDoc.data.content).toContain("quick brown fox");
  });
});

describe("collections", () => {
  it("same-named collections stay separate, and deleting one doesn't touch the other user's", async () => {
    const { aliceHl, bobHl } = await twoUsersOnOneArticle();

    expect(ids(await collectionHighlights(ALICE, "research"))).toEqual([aliceHl.annotationId]);
    expect(ids(await collectionHighlights(BOB, "research"))).toEqual([bobHl.annotationId]);

    expect((await call(BOB, "DELETE", "/collections/{collectionId}", { collectionId: "research" })).status).toBe(204);
    expect(ids(await collectionHighlights(ALICE, "research"))).toEqual([aliceHl.annotationId]);
    expect((await call(ALICE, "GET", "/collections")).data.map((c: Item) => c.name)).toEqual(["Research"]);
  });

  it("a membership row pointing at another user's highlight is ignored, not followed", async () => {
    const { docId, aliceHl } = await twoUsersOnOneArticle();
    // A bad row in Bob's collection pointing at Alice's highlight (as the old, unchecked PATCH could create)
    tables.items.set(`${BOB}#research|${aliceHl.annotationId}`, {
      collectionKey: `${BOB}#research`, annotationId: aliceHl.annotationId, docId,
    });

    expect(JSON.stringify(await collectionHighlights(BOB, "research"))).not.toContain("alice");

    // Deleting Bob's collection must not edit Alice's highlight through that row
    await call(BOB, "DELETE", "/collections/{collectionId}", { collectionId: "research" });
    const [alices] = (await listHighlights(ALICE, docId)).filter((h) => h.annotationId === aliceHl.annotationId);
    expect(alices.collectionIds).toEqual(["research"]);
  });

  it("can't rename or delete another user's collection", async () => {
    await call(ALICE, "POST", "/collections", {}, { name: "Alice Only" });
    const rename = await call(BOB, "PATCH", "/collections/{collectionId}", { collectionId: "alice-only" }, { name: "Mine" });
    expect(rename.status).toBe(404);
    await call(BOB, "DELETE", "/collections/{collectionId}", { collectionId: "alice-only" });
    expect((await call(ALICE, "GET", "/collections")).data.map((c: Item) => c.name)).toEqual(["Alice Only"]);
  });
});

describe("existing accounts", () => {
  it("the owner's legacy data (userId 'brianna') and the demo account's data stay visible to them only", async () => {
    const docId = "legacy-doc";
    tables.documents.set(`brianna|${docId}`, { userId: "brianna", docId, url: ARTICLE_URL, title: "Old" });
    tables.annotations.set(`${docId}|old-1`, { docId, annotationId: "old-1", userId: "brianna", exact: "x", note: "mine" });
    tables.documents.set(`${DEMO_SUB}|${docId}`, { userId: DEMO_SUB, docId, url: ARTICLE_URL, title: "Old" });
    tables.annotations.set(`${docId}|demo-1`, { docId, annotationId: "demo-1", userId: DEMO_SUB, exact: "y", note: "demo" });

    expect(ids(await listHighlights(LEGACY_SUB, docId))).toEqual(["old-1"]);
    expect(ids(await listHighlights(DEMO_SUB, docId))).toEqual(["demo-1"]);
    expect(await listHighlights(ALICE, docId)).toEqual([]);

    // The owner can still edit their legacy highlight
    expect((await patchHighlight(LEGACY_SUB, docId, "old-1", { note: "edited" })).status).toBe(200);
  });
});
