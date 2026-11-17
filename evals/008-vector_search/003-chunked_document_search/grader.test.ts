import { beforeEach, expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import {
  addDocuments,
  compareFunctionSpec,
  compareSchema,
  deleteAllDocuments,
  getLatestOutputProjectDir,
  listTable,
  responseAdminClient,
  responseClient,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { Doc, Id } from "./answer/convex/_generated/dataModel";

type Result = {
  documentId: Id<"documents">;
  title: string;
  bestChunk: string;
  score: number;
};

const QUERY = [1, 0, 0, 0];

// Cosine similarity to QUERY is `cos`; the remainder goes on `axis`.
function withSimilarity(cos: number, axis: number): number[] {
  const values = [cos, 0, 0, 0];
  values[axis] = Math.sqrt(1 - cos * cos);
  return values;
}

// Chunk similarities to QUERY, listed in insertion order. Alpha's ten chunks
// are all closer than any other document's chunks; Gamma's best chunk is
// inserted after a weaker one; Empty has no chunks at all.
const DOCUMENTS: { title: string; chunkScores: number[] }[] = [
  {
    title: "Alpha",
    chunkScores: [0.9, 0.91, 0.92, 0.93, 0.94, 0.95, 0.96, 0.97, 0.98, 0.99],
  },
  { title: "Beta", chunkScores: [0.85] },
  { title: "Gamma", chunkScores: [0.2, 0.8] },
  { title: "Delta", chunkScores: [0.5] },
  { title: "Epsilon", chunkScores: [0.1, 0.05, 0] },
  { title: "Empty", chunkScores: [] },
];

const chunkText = (title: string, score: number) =>
  `${title.toLowerCase()}-${score}`;

async function seed(): Promise<Map<string, Id<"documents">>> {
  await addDocuments(
    responseAdminClient,
    "documents",
    DOCUMENTS.map(({ title }) => ({ title })),
  );
  const docs = (await listTable(
    responseAdminClient,
    "documents",
  )) as Doc<"documents">[];
  const ids = new Map(docs.map((doc) => [doc.title, doc._id]));

  let axis = 1;
  const chunks = DOCUMENTS.flatMap(({ title, chunkScores }) =>
    chunkScores.map((score) => {
      axis = (axis % 3) + 1;
      return {
        documentId: ids.get(title)!,
        text: chunkText(title, score),
        embedding: withSimilarity(score, axis),
      };
    }),
  );
  await addDocuments(responseAdminClient, "chunks", chunks);
  return ids;
}

async function search(limit: number): Promise<Result[]> {
  return (await responseClient.action(api.index.searchDocuments, {
    embedding: QUERY,
    limit,
  })) as Result[];
}

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["chunks", "documents"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  // Internal query names are not dictated by the task.
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

test("returns limit distinct documents even when one document's chunks dominate", async () => {
  const ids = await seed();

  // Alpha owns the ten closest chunks. Searching for only a few chunks
  // returns Alpha alone.
  const results = await search(3);

  expect(results.map((r) => r.documentId)).toEqual([
    ids.get("Alpha"),
    ids.get("Beta"),
    ids.get("Gamma"),
  ]);
});

test("returns limit documents when the closest chunks belong to a few documents", async () => {
  // Nineteen documents own ten chunks each, all closer to the query than the
  // best chunk of "Light", so "Light" only appears after 190 chunk hits.
  const pad = (i: number) => String(i).padStart(2, "0");
  await addDocuments(responseAdminClient, "documents", [
    ...Array.from({ length: 19 }, (_, i) => ({ title: `Heavy-${pad(i)}` })),
    { title: "Light" },
    { title: "Lighter" },
  ]);
  const docs = (await listTable(
    responseAdminClient,
    "documents",
    100,
  )) as Doc<"documents">[];
  const idOf = (title: string) => docs.find((doc) => doc.title === title)!._id;
  const chunks = [];
  for (let i = 0; i < 19; i++) {
    const best = 0.99 - i * 0.009;
    for (let k = 0; k < 10; k++) {
      chunks.push({
        documentId: idOf(`Heavy-${pad(i)}`),
        text: `heavy-${i}-${k}`,
        embedding: withSimilarity(best - k * 0.0005, 1 + (k % 3)),
      });
    }
  }
  chunks.push(
    { documentId: idOf("Light"), text: "light", embedding: withSimilarity(0.5, 1) },
    { documentId: idOf("Lighter"), text: "lighter", embedding: withSimilarity(0.4, 2) },
  );
  await addDocuments(responseAdminClient, "chunks", chunks);

  const results = await search(20);

  expect(results.map((r) => r.title)).toEqual([
    ...Array.from({ length: 19 }, (_, i) => `Heavy-${pad(i)}`),
    "Light",
  ]);
});

test("reports each document's best chunk and its score", async () => {
  await seed();

  const results = await search(3);

  expect(
    results.map(({ title, bestChunk }) => ({ title, bestChunk })),
  ).toEqual([
    { title: "Alpha", bestChunk: "alpha-0.99" },
    { title: "Beta", bestChunk: "beta-0.85" },
    { title: "Gamma", bestChunk: "gamma-0.8" },
  ]);
  [0.99, 0.85, 0.8].forEach((score, i) => {
    expect(results[i].score).toBeCloseTo(score, 3);
  });
});

test("returns the single best document for limit 1", async () => {
  const ids = await seed();

  const results = await search(1);

  expect(results).toHaveLength(1);
  expect(results[0].documentId).toEqual(ids.get("Alpha"));
  expect(results[0].bestChunk).toBe("alpha-0.99");
  expect(results[0].score).toBeCloseTo(0.99, 3);
});

test("includes each document at most once, in score order", async () => {
  const ids = await seed();

  const results = await search(20);

  // Empty has no chunks, so only five documents can match.
  expect(results.map((r) => r.documentId)).toEqual([
    ids.get("Alpha"),
    ids.get("Beta"),
    ids.get("Gamma"),
    ids.get("Delta"),
    ids.get("Epsilon"),
  ]);
  expect(results.map((r) => r.bestChunk)).toEqual([
    "alpha-0.99",
    "beta-0.85",
    "gamma-0.8",
    "delta-0.5",
    "epsilon-0.1",
  ]);
});

test("results have exactly the specified fields", async () => {
  await seed();
  const results = await search(5);
  expect(results.length).toBeGreaterThan(0);
  for (const result of results) {
    expect(Object.keys(result).sort()).toEqual([
      "bestChunk",
      "documentId",
      "score",
      "title",
    ]);
  }
});

test("returns an empty array when there are no chunks", async () => {
  expect(await search(5)).toEqual([]);
});

// The model's Convex source files, excluding generated code and tests.
function readConvexSources(): { path: string; text: string }[] {
  const projectDir = getLatestOutputProjectDir(
    "008-vector_search",
    "003-chunked_document_search",
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

test("ranks with the vector index and loads chunks only by ID", () => {
  const { vectorSearchTables, tableQueries } = analyzeSources("chunks");
  expect(vectorSearchTables).toContain("chunks");
  expect(tableQueries).toEqual([]);
});
