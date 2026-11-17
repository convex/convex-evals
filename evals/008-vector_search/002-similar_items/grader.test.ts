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

type Result = { _id: Id<"products">; name: string; score: number };

// Cosine similarity to [1, 0, 0, 0] is `cos`; the remainder goes on `axis`.
function withSimilarity(cos: number, axis: number): number[] {
  const values = [cos, 0, 0, 0];
  values[axis] = Math.sqrt(1 - cos * cos);
  return values;
}

const SEED = [
  { name: "chair-source", category: "chairs", embedding: [1, 0, 0, 0] },
  // Identical embedding to the source, so it scores 1.0 like the source.
  { name: "chair-twin", category: "chairs", embedding: [1, 0, 0, 0] },
  { name: "chair-0.9", category: "chairs", embedding: withSimilarity(0.9, 1) },
  { name: "chair-0.7", category: "chairs", embedding: withSimilarity(0.7, 2) },
  { name: "chair-0.5", category: "chairs", embedding: withSimilarity(0.5, 3) },
  { name: "chair-0.3", category: "chairs", embedding: withSimilarity(0.3, 1) },
  // Matches the chair source exactly, but is in another category.
  { name: "table-x", category: "tables", embedding: [1, 0, 0, 0] },
  { name: "table-z", category: "tables", embedding: [0.6, 0.8, 0, 0] },
  { name: "table-y", category: "tables", embedding: [0, 1, 0, 0] },
  { name: "lamp-only", category: "lamps", embedding: [0, 0, 1, 0] },
];

async function seedProducts(): Promise<Map<string, Id<"products">>> {
  await addDocuments(responseAdminClient, "products", SEED);
  const docs = (await listTable(
    responseAdminClient,
    "products",
  )) as Doc<"products">[];
  return new Map(docs.map((doc) => [doc.name, doc._id]));
}

async function similar(
  productId: Id<"products">,
  limit: number,
): Promise<Result[]> {
  return (await responseClient.action(api.index.similarProducts, {
    productId,
    limit,
  })) as Result[];
}

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["products"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  // Internal query names are not dictated by the task.
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

test("returns the most similar other products in the same category", async () => {
  const ids = await seedProducts();

  const results = await similar(ids.get("chair-source")!, 3);

  expect(results.map((r) => r.name)).toEqual([
    "chair-twin",
    "chair-0.9",
    "chair-0.7",
  ]);
  expect(results.map((r) => r._id)).toEqual([
    ids.get("chair-twin"),
    ids.get("chair-0.9"),
    ids.get("chair-0.7"),
  ]);
  [1, 0.9, 0.7].forEach((score, i) => {
    expect(results[i].score).toBeCloseTo(score, 3);
  });
});

test("returns exactly limit products when enough exist", async () => {
  const ids = await seedProducts();

  // The source is its own best match, so a search for only `limit` hits
  // comes back one short after the source is removed.
  for (const limit of [1, 2, 5]) {
    const results = await similar(ids.get("chair-source")!, limit);
    expect(results).toHaveLength(limit);
    expect(results.map((r) => r._id)).not.toContain(ids.get("chair-source"));
  }
  const five = await similar(ids.get("chair-source")!, 5);
  expect(five.map((r) => r.name)).toEqual([
    "chair-twin",
    "chair-0.9",
    "chair-0.7",
    "chair-0.5",
    "chair-0.3",
  ]);
});

test("returns every other product when the category has fewer than limit", async () => {
  const ids = await seedProducts();

  const results = await similar(ids.get("chair-source")!, 50);

  expect(results.map((r) => r.name)).toEqual([
    "chair-twin",
    "chair-0.9",
    "chair-0.7",
    "chair-0.5",
    "chair-0.3",
  ]);
});

test("searches from the given product's own embedding and category", async () => {
  const ids = await seedProducts();

  // From table-y [0, 1, 0, 0], table-z scores 0.8 and table-x scores 0.
  const results = await similar(ids.get("table-y")!, 2);

  expect(results.map((r) => r.name)).toEqual(["table-z", "table-x"]);
  expect(results[0].score).toBeCloseTo(0.8, 3);
  expect(results[1].score).toBeCloseTo(0, 3);
});

test("excludes only the product itself, even when it has an identical twin", async () => {
  const ids = await seedProducts();

  // The source and its twin tie at 1.0, so dropping the first hit instead of
  // the product's own ID fails for one of the two.
  const fromSource = await similar(ids.get("chair-source")!, 1);
  const fromTwin = await similar(ids.get("chair-twin")!, 1);

  expect(fromSource.map((r) => r.name)).toEqual(["chair-twin"]);
  expect(fromTwin.map((r) => r.name)).toEqual(["chair-source"]);
});

test("products in other categories do not crowd out the product's own category", async () => {
  const ids = await seedProducts();
  // More exact matches elsewhere than one vector search can return, so
  // filtering by category after the search leaves nothing.
  await addDocuments(
    responseAdminClient,
    "products",
    Array.from({ length: 260 }, (_, i) => ({
      name: `outlet-${i}`,
      category: "outlet",
      embedding: [1, 0, 0, 0],
    })),
  );

  const results = await similar(ids.get("chair-source")!, 3);

  expect(results.map((r) => r.name)).toEqual([
    "chair-twin",
    "chair-0.9",
    "chair-0.7",
  ]);
});

test("returns more than ten products when the limit allows", async () => {
  await addDocuments(
    responseAdminClient,
    "products",
    Array.from({ length: 14 }, (_, i) => ({
      name: `sofa-${i}`,
      category: "sofas",
      embedding: i === 0 ? [1, 0, 0, 0] : withSimilarity(0.98 - i * 0.04, 1 + (i % 3)),
    })),
  );
  const sofas = (await listTable(responseAdminClient, "products")) as Doc<"products">[];
  const source = sofas.find((p) => p.name === "sofa-0")!;

  const results = await similar(source._id, 12);

  expect(results.map((r) => r.name)).toEqual(
    Array.from({ length: 12 }, (_, i) => `sofa-${i + 1}`),
  );
});

test("a product alone in its category gets no recommendations", async () => {
  const ids = await seedProducts();
  expect(await similar(ids.get("lamp-only")!, 5)).toEqual([]);
});

test("returns an empty array for a product that does not exist", async () => {
  const ids = await seedProducts();
  const deletedId = ids.get("chair-source")!;
  await deleteAllDocuments(responseAdminClient, ["products"]);

  expect(await similar(deletedId, 5)).toEqual([]);
});

test("results have exactly the specified fields", async () => {
  const ids = await seedProducts();
  const results = await similar(ids.get("chair-source")!, 3);
  expect(results.length).toBeGreaterThan(0);
  for (const result of results) {
    expect(Object.keys(result).sort()).toEqual(["_id", "name", "score"]);
  }
});

// The model's Convex source files, excluding generated code and tests.
function readConvexSources(): { path: string; text: string }[] {
  const projectDir = getLatestOutputProjectDir(
    "008-vector_search",
    "002-similar_items",
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

test("searches with the vector index and loads products only by ID", () => {
  const { vectorSearchTables, tableQueries } = analyzeSources("products");
  expect(vectorSearchTables).toContain("products");
  expect(tableQueries).toEqual([]);
});
