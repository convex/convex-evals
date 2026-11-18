import { beforeEach, expect, test } from "vitest";
import {
  compareFunctionSpec,
  deleteAllDocuments,
  getSchema,
  findTable,
  listTable,
  responseAdminClient,
  responseClient,
  withIdentity,
} from "../../../grader";
import {
  findTableAccess,
  readModelConvexSources,
} from "../../../grader/modelSource";
import { api } from "./answer/convex/_generated/api";
import { Doc, Id } from "./answer/convex/_generated/dataModel";

const ISSUER = "https://test-auth.example.com";
const alice = withIdentity({ subject: "alice", issuer: ISSUER, name: "Alice" });
const bob = withIdentity({ subject: "bob", issuer: ISSUER, name: "Bob" });
const carol = withIdentity({ subject: "carol", issuer: ISSUER, name: "Carol" });
type Client = typeof alice;

type SearchResult = { _id: Id<"notes">; text: string; score: number };

// 8-dimension vector whose cosine similarity with the query e0 is `cos`.
function withSimilarity(cos: number, axis = 1): number[] {
  const values = new Array<number>(8).fill(0);
  values[0] = cos;
  values[axis] = Math.sqrt(1 - cos * cos);
  return values;
}
const QUERY = withSimilarity(1);

async function createNote(
  client: Client,
  text: string,
  visibility: "private" | "public",
  embedding: number[],
): Promise<Id<"notes">> {
  return (await client.mutation(api.index.createNote, {
    text,
    visibility,
    embedding,
  })) as Id<"notes">;
}

async function search(
  client: Client,
  embedding: number[],
  limit: number,
): Promise<SearchResult[]> {
  return (await client.action(api.index.searchNotes, {
    embedding,
    limit,
  })) as SearchResult[];
}

// Similarities to QUERY: bob-private 0.95, alice-private 0.9,
// alice-public 0.8, bob-public 0.7.
async function seedNotes() {
  return {
    alicePrivate: await createNote(alice, "alice-private", "private", withSimilarity(0.9, 1)),
    alicePublic: await createNote(alice, "alice-public", "public", withSimilarity(0.8, 2)),
    bobPublic: await createNote(bob, "bob-public", "public", withSimilarity(0.7, 3)),
    bobPrivate: await createNote(bob, "bob-private", "private", withSimilarity(0.95, 4)),
  };
}

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["notes"]);
});

test("compare function spec", async ({ skip }) => {
  // The hydration query's name is not dictated by the task.
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

test("schema declares the 8-dimension vector index", async () => {
  const schema = await getSchema(responseAdminClient);
  const notes = findTable(schema, "notes") as {
    vectorIndexes?: {
      indexDescriptor: string;
      vectorField: string;
      dimensions: number;
    }[];
  } | null;
  expect(notes).not.toBeNull();
  expect(
    notes?.vectorIndexes?.map(({ indexDescriptor, vectorField, dimensions }) => ({
      indexDescriptor,
      vectorField,
      dimensions,
    })),
  ).toEqual([
    { indexDescriptor: "by_embedding", vectorField: "embedding", dimensions: 8 },
  ]);
});

test("a search covers the caller's own notes and other users' public notes", async () => {
  const ids = await seedNotes();

  const aliceResults = await search(alice, QUERY, 10);
  expect(aliceResults.map((r) => r._id)).toEqual([
    ids.alicePrivate,
    ids.alicePublic,
    ids.bobPublic,
  ]);
  expect(aliceResults.map((r) => r.text)).toEqual([
    "alice-private",
    "alice-public",
    "bob-public",
  ]);
  [0.9, 0.8, 0.7].forEach((score, i) => {
    expect(aliceResults[i].score).toBeCloseTo(score, 3);
  });

  const bobResults = await search(bob, QUERY, 10);
  expect(bobResults.map((r) => r._id)).toEqual([
    ids.bobPrivate,
    ids.alicePublic,
    ids.bobPublic,
  ]);
});

test("stores the caller's tokenIdentifier as the owner", async () => {
  await createNote(alice, "mine", "private", QUERY);

  const notes = (await listTable(responseAdminClient, "notes")) as Doc<"notes">[];
  expect(notes.map((note) => note.ownerTokenIdentifier)).toEqual([
    `${ISSUER}|alice`,
  ]);
});

test("returns more than ten notes when the limit allows", { timeout: 30_000 }, async () => {
  const ids: Id<"notes">[] = [];
  for (let i = 0; i < 12; i++) {
    ids.push(
      await createNote(alice, `alice-${i}`, "private", withSimilarity(0.9 - i * 0.03, 1 + (i % 7))),
    );
  }
  await createNote(bob, "bob-private", "private", QUERY);

  const results = await search(alice, QUERY, 12);

  expect(results.map((r) => r._id)).toEqual(ids);
});

test("ranks by the caller's embedding", async () => {
  const ids = await seedNotes();

  // 0.6 on axis 1 and 0.8 on axis 3: bob-public scores 0.571, alice-private
  // 0.262 and alice-public 0, which reverses the order for QUERY.
  const other = [0, 0.6, 0, 0.8, 0, 0, 0, 0];
  const results = await search(alice, other, 10);

  expect(results.map((r) => r._id)).toEqual([
    ids.bobPublic,
    ids.alicePrivate,
    ids.alicePublic,
  ]);
  expect(results[0].score).toBeCloseTo(0.8 * Math.sqrt(1 - 0.7 * 0.7), 3);
  expect(results[1].score).toBeCloseTo(0.6 * Math.sqrt(1 - 0.9 * 0.9), 3);
  expect(results[2].score).toBeCloseTo(0, 3);
});

test("returns at most limit notes", async () => {
  const ids = await seedNotes();
  const results = await search(alice, QUERY, 2);
  expect(results.map((r) => r._id)).toEqual([ids.alicePrivate, ids.alicePublic]);
});

test(
  "invisible notes that are more similar do not crowd out visible ones",
  { timeout: 60_000 },
  async () => {
    const ids = await seedNotes();

    // 300 of Carol's private notes match the query exactly (similarity 1.0),
    // more than the 256 results one vector search can return. Searching
    // without the visibility filter and dropping invisible hits afterwards
    // leaves Alice with nothing.
    for (let batch = 0; batch < 6; batch++) {
      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          createNote(carol, `carol-${batch * 50 + i}`, "private", QUERY),
        ),
      );
    }

    const results = await search(alice, QUERY, 3);
    expect(results.map((r) => r._id)).toEqual([
      ids.alicePrivate,
      ids.alicePublic,
      ids.bobPublic,
    ]);
  },
);

test("results have exactly the specified fields", async () => {
  await seedNotes();
  const results = await search(alice, QUERY, 10);
  expect(results.length).toBeGreaterThan(0);
  for (const result of results) {
    expect(Object.keys(result).sort()).toEqual(["_id", "score", "text"]);
  }
});

test("createNote and searchNotes require authentication", async () => {
  await expect(
    responseClient.mutation(api.index.createNote, {
      text: "anonymous",
      visibility: "public",
      embedding: QUERY,
    }),
  ).rejects.toThrow();
  await expect(
    responseClient.action(api.index.searchNotes, { embedding: QUERY, limit: 5 }),
  ).rejects.toThrow();
});

test("searches with the vector index and loads notes only by ID", () => {
  // Loading hits needs only db.get by ID, so a query on the searched table
  // means rows are found another way, such as ranking them in JavaScript.
  const { vectorSearchCalls, tableQueries } = findTableAccess(
    readModelConvexSources("008-vector_search", "000-visibility_or_filter"),
    "notes",
  );
  expect(vectorSearchCalls).toBeGreaterThan(0);
  expect(tableQueries).toEqual([]);
});
