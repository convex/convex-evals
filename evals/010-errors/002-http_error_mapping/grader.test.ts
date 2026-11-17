import { beforeEach, expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { ConvexError, type Value } from "convex/values";
import {
  addDocuments,
  compareFunctionSpec,
  compareSchema,
  deleteAllDocuments,
  getLatestOutputProjectDir,
  listTable,
  responseAdminClient,
  responseClient,
  siteUrl,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { Doc } from "./answer/convex/_generated/dataModel";

async function seedProducts() {
  await addDocuments(responseAdminClient, "products", [
    { sku: "LAMP-1", stock: 5 },
    { sku: "RUG-2", stock: 0 },
  ]);
}

async function stock(): Promise<Record<string, number>> {
  const products = (await listTable(
    responseAdminClient,
    "products",
  )) as Doc<"products">[];
  return Object.fromEntries(products.map((p) => [p.sku, p.stock]));
}

async function orders(): Promise<Doc<"orders">[]> {
  return (await listTable(responseAdminClient, "orders")) as Doc<"orders">[];
}

// POST /orders with a JSON value, or a raw string body when `raw` is set.
async function post(
  body: unknown,
  raw = false,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${siteUrl}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
  expect(response.headers.get("content-type") ?? "").toMatch(
    /^application\/json/,
  );
  return { status: response.status, body: await response.json() };
}

// The payload the client receives on the thrown error object.
async function failurePayload(call: Promise<unknown>): Promise<unknown> {
  const error: unknown = await call.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "expected the call to fail").not.toBeNull();
  expect(error).toBeInstanceOf(ConvexError);
  return (error as ConvexError<Value>).data;
}

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["orders", "products"]);
  await seedProducts();
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

test("placeOrder places an order for app clients", async () => {
  const orderId = await responseClient.mutation(api.index.placeOrder, {
    sku: "LAMP-1",
    quantity: 2,
  });

  expect(await stock()).toEqual({ "LAMP-1": 3, "RUG-2": 0 });
  const rows = await orders();
  expect(rows.map(({ _id, sku, quantity }) => ({ _id, sku, quantity }))).toEqual([
    { _id: orderId, sku: "LAMP-1", quantity: 2 },
  ]);
});

test("placeOrder failures carry their payloads to app clients", async () => {
  const place = (sku: string, quantity: number) =>
    responseClient.mutation(api.index.placeOrder, { sku, quantity });

  expect(await failurePayload(place("LAMP-1", 0))).toEqual({
    code: "INVALID_QUANTITY",
  });
  expect(await failurePayload(place("LAMP-1", 1.5))).toEqual({
    code: "INVALID_QUANTITY",
  });
  expect(await failurePayload(place("NOPE-9", 1))).toEqual({
    code: "PRODUCT_NOT_FOUND",
    sku: "NOPE-9",
  });
  expect(await failurePayload(place("LAMP-1", 6))).toEqual({
    code: "OUT_OF_STOCK",
    available: 5,
  });
  // The quantity is checked before the product and its stock.
  expect(await failurePayload(place("NOPE-9", 0))).toEqual({
    code: "INVALID_QUANTITY",
  });
  expect(await failurePayload(place("LAMP-1", 6.5))).toEqual({
    code: "INVALID_QUANTITY",
  });

  expect(await stock()).toEqual({ "LAMP-1": 5, "RUG-2": 0 });
  expect(await orders()).toEqual([]);
});

test("POST /orders places an order and responds 201 with its ID", async () => {
  const response = await post({ sku: "LAMP-1", quantity: 3 });

  expect(response.status).toBe(201);
  const rows = await orders();
  expect(rows).toHaveLength(1);
  expect(response.body).toEqual({ orderId: rows[0]._id });
  expect(rows[0]).toMatchObject({ sku: "LAMP-1", quantity: 3 });
  expect(await stock()).toEqual({ "LAMP-1": 2, "RUG-2": 0 });
});

test("malformed requests get 400 INVALID_REQUEST", async () => {
  const malformed: [unknown, boolean][] = [
    ["{not json", true],
    [{ quantity: 1 }, false],
    [{ sku: 42, quantity: 1 }, false],
    [{ sku: "LAMP-1", quantity: "2" }, false],
    [{ sku: "LAMP-1" }, false],
    [null, false],
  ];
  for (const [body, raw] of malformed) {
    const response = await post(body, raw);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: { code: "INVALID_REQUEST" } });
  }
  expect(await orders()).toEqual([]);
});

test("INVALID_QUANTITY maps to 400", async () => {
  for (const [sku, quantity] of [
    ["LAMP-1", 0],
    ["LAMP-1", -2],
    ["LAMP-1", 1.5],
    ["NOPE-9", 0],
    ["LAMP-1", 6.5],
  ] as const) {
    const response = await post({ sku, quantity });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: { code: "INVALID_QUANTITY" } });
  }
  expect(await stock()).toEqual({ "LAMP-1": 5, "RUG-2": 0 });
});

test("PRODUCT_NOT_FOUND maps to 404 with the sku", async () => {
  const response = await post({ sku: "NOPE-9", quantity: 1 });

  expect(response.status).toBe(404);
  expect(response.body).toEqual({
    error: { code: "PRODUCT_NOT_FOUND", sku: "NOPE-9" },
  });
  expect(await orders()).toEqual([]);
});

test("OUT_OF_STOCK maps to 409 with the available stock", async () => {
  const lamp = await post({ sku: "LAMP-1", quantity: 6 });
  expect(lamp.status).toBe(409);
  expect(lamp.body).toEqual({ error: { code: "OUT_OF_STOCK", available: 5 } });

  const rug = await post({ sku: "RUG-2", quantity: 1 });
  expect(rug.status).toBe(409);
  expect(rug.body).toEqual({ error: { code: "OUT_OF_STOCK", available: 0 } });

  expect(await stock()).toEqual({ "LAMP-1": 5, "RUG-2": 0 });
  expect(await orders()).toEqual([]);
});

// The model's Convex source files, excluding generated code and tests.
function readConvexSources(): { path: string; text: string }[] {
  const projectDir = getLatestOutputProjectDir(
    "010-errors",
    "002-http_error_mapping",
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

test("the HTTP route places orders through placeOrder itself", () => {
  // The task requires the endpoint to call the public mutation with
  // ctx.runMutation and translate the ConvexErrors it throws, rather than
  // sharing logic through a helper that returns error values.
  const targets: string[] = [];
  for (const source of readConvexSources()) {
    const file = ts.createSourceFile(
      source.path,
      source.text,
      ts.ScriptTarget.Latest,
      true,
    );
    // References stored in constants, e.g. `const place = api.index.placeOrder`.
    const aliases = new Map<string, string>();
    const collectAliases = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined
      ) {
        aliases.set(node.name.text, node.initializer.getText(file));
      }
      ts.forEachChild(node, collectAliases);
    };
    collectAliases(file);
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "runMutation" &&
        node.arguments.length > 0
      ) {
        const argument = node.arguments[0];
        const text = ts.isIdentifier(argument)
          ? (aliases.get(argument.text) ?? argument.text)
          : argument.getText(file);
        targets.push(text.replace(/\s+/g, ""));
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  expect(targets).toContain("api.index.placeOrder");
});
