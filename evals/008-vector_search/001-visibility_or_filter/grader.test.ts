import { beforeEach, expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import {
  compareFunctionSpec,
  deleteAllDocuments,
  getLatestOutputProjectDir,
  getSchema,
  findTable,
  listTable,
  responseAdminClient,
  responseClient,
  withIdentity,
} from "../../../grader";
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

// The model's Convex source files, excluding generated code and tests.
function readConvexSources(): { path: string; text: string }[] {
  const projectDir = getLatestOutputProjectDir(
    "008-vector_search",
    "001-visibility_or_filter",
  );
  const sources: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "_generated" || entry.name === "node_modules") {
        continue;
      }
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (
        /\.(ts|tsx|js|mjs)$/.test(entry.name) &&
        !/\.(test|spec)\.[jt]sx?$/.test(entry.name)
      ) {
        sources.push({
          path: relative(projectDir, fullPath),
          text: readFileSync(fullPath, "utf8"),
        });
      }
    }
  };
  walk(join(projectDir, "convex"));
  return sources;
}

// Finds the tables passed to `vectorSearch`, and every query started on
// `table`. Loading search hits needs only `db.get` by ID, so a query on the
// searched table means rows are found another way, such as loading them all
// and ranking them in JavaScript.
function analyzeSources(table: string): {
  vectorSearchTables: string[];
  tableQueries: string[];
} {
  const vectorSearchTables: string[] = [];
  const tableQueries: string[] = [];
  for (const source of readConvexSources()) {
    const file = ts.createSourceFile(
      source.path,
      source.text,
      ts.ScriptTarget.Latest,
      true,
    );
    // String constants, so a table name passed through one still resolves.
    const constants = new Map<string, string>();
    const collectConstants = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        ts.isStringLiteralLike(node.initializer)
      ) {
        constants.set(node.name.text, node.initializer.text);
      }
      ts.forEachChild(node, collectConstants);
    };
    collectConstants(file);
    const tableName = (node: ts.Expression | undefined) => {
      if (node === undefined) return undefined;
      if (ts.isStringLiteralLike(node)) return node.text;
      if (ts.isIdentifier(node)) return constants.get(node.text);
      return undefined;
    };
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ts.isIdentifier(callee)
            ? callee.text
            : undefined;
        if (name === "vectorSearch") {
          vectorSearchTables.push(tableName(node.arguments[0]) ?? "(unknown)");
        }
        if (
          name === "query" &&
          ts.isPropertyAccessExpression(callee) &&
          tableName(node.arguments[0]) === table
        ) {
          const { line } = file.getLineAndCharacterOfPosition(node.getStart());
          tableQueries.push(`${source.path}:${line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return { vectorSearchTables, tableQueries };
}

test("searches with the vector index and loads notes only by ID", () => {
  const { vectorSearchTables, tableQueries } = analyzeSources("notes");
  expect(vectorSearchTables).toContain("notes");
  expect(tableQueries).toEqual([]);
});
