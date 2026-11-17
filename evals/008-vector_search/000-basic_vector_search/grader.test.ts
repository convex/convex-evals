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

const DIMENSIONS = 1536;

// A 1536-dimension vector that is zero except for the given components.
function vector(components: Record<number, number>): number[] {
  const values = new Array<number>(DIMENSIONS).fill(0);
  for (const [index, value] of Object.entries(components)) {
    values[Number(index)] = value;
  }
  return values;
}

// Cosine similarity against the query vector e0 is noted for each article.
const SEED = [
  { title: "exact", embedding: vector({ 0: 1 }) }, // 1.0
  { title: "close", embedding: vector({ 0: 0.8, 1: 0.6 }) }, // 0.8
  { title: "related", embedding: vector({ 0: 0.6, 2: 0.8 }) }, // 0.6
  { title: "mixed", embedding: vector({ 0: 0.5, 1: 0.5, 2: 0.5, 3: 0.5 }) }, // 0.5
  { title: "unrelated", embedding: vector({ 3: 1 }) }, // 0.0
  { title: "opposite", embedding: vector({ 0: -1 }) }, // -1.0
];

type SearchResult = { _id: Id<"articles">; title: string; score: number };

async function seedArticles(): Promise<Map<string, Id<"articles">>> {
  await addDocuments(
    responseAdminClient,
    "articles",
    SEED.map((article) => ({ ...article, body: `Body of ${article.title}` })),
  );
  const docs = (await listTable(
    responseAdminClient,
    "articles",
  )) as Doc<"articles">[];
  return new Map(docs.map((doc) => [doc.title, doc._id]));
}

async function search(
  embedding: number[],
  limit: number,
): Promise<SearchResult[]> {
  return (await responseClient.action(api.index.searchArticles, {
    embedding,
    limit,
  })) as SearchResult[];
}

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["articles"]);
});

test("compare schema", async ({ skip }) => {
  // Checks the vector index itself: name, vector field and 1536 dimensions.
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  // The internal hydration query's name is not dictated by the task.
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

test("returns articles in descending similarity order with their scores", async () => {
  const ids = await seedArticles();

  const results = await search(vector({ 0: 1 }), 10);

  expect(results.map((result) => result._id)).toEqual([
    ids.get("exact"),
    ids.get("close"),
    ids.get("related"),
    ids.get("mixed"),
    ids.get("unrelated"),
    ids.get("opposite"),
  ]);
  expect(results.map((result) => result.title)).toEqual([
    "exact",
    "close",
    "related",
    "mixed",
    "unrelated",
    "opposite",
  ]);
  const expectedScores = [1, 0.8, 0.6, 0.5, 0, -1];
  results.forEach((result, i) => {
    expect(result.score).toBeCloseTo(expectedScores[i], 3);
  });
});

test("returns at most limit articles", async () => {
  const ids = await seedArticles();

  const results = await search(vector({ 0: 1 }), 2);

  expect(results.map((result) => result._id)).toEqual([
    ids.get("exact"),
    ids.get("close"),
  ]);
});

test("returns more than ten articles when the limit allows", async () => {
  // Fifteen articles whose similarity to e0 falls from 0.98 to 0.56.
  const extra = Array.from({ length: 15 }, (_, i) => {
    const cos = 0.98 - i * 0.03;
    return {
      title: `extra-${i}`,
      body: "",
      embedding: vector({ 0: cos, [4 + i]: Math.sqrt(1 - cos * cos) }),
    };
  });
  await addDocuments(responseAdminClient, "articles", extra);

  const results = await search(vector({ 0: 1 }), 12);

  expect(results.map((result) => result.title)).toEqual(
    extra.slice(0, 12).map((article) => article.title),
  );
});

test("ranks by the caller's embedding", async () => {
  const ids = await seedArticles();

  // Against e1 the best matches are "close" (0.6) and "mixed" (0.5).
  const results = await search(vector({ 1: 1 }), 2);

  expect(results.map((result) => result._id)).toEqual([
    ids.get("close"),
    ids.get("mixed"),
  ]);
  expect(results[0].score).toBeCloseTo(0.6, 3);
  expect(results[1].score).toBeCloseTo(0.5, 3);
});

test("results have exactly the specified fields", async () => {
  await seedArticles();

  const results = await search(vector({ 0: 1 }), 10);

  expect(results.length).toBeGreaterThan(0);
  for (const result of results) {
    expect(Object.keys(result).sort()).toEqual(["_id", "score", "title"]);
  }
});

test("returns an empty array when there are no articles", async () => {
  expect(await search(vector({ 0: 1 }), 5)).toEqual([]);
});

// The model's Convex source files, excluding generated code and tests.
function readConvexSources(): { path: string; text: string }[] {
  const projectDir = getLatestOutputProjectDir(
    "008-vector_search",
    "000-basic_vector_search",
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

test("searches with the vector index and loads articles only by ID", () => {
  const { vectorSearchTables, tableQueries } = analyzeSources("articles");
  expect(vectorSearchTables).toContain("articles");
  expect(tableQueries).toEqual([]);
});
