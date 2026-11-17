import { describe, expect, it } from "bun:test";
import { findTableAccess, type ModelSource } from "./modelSource.js";

const file = (path: string, text: string): ModelSource => ({ path, text });

function queriesOn(table: string, ...sources: ModelSource[]): string[] {
  return findTableAccess(sources, table).tableQueries;
}

describe("findTableAccess", () => {
  it("finds a query on the table written as a literal", () => {
    expect(
      queriesOn(
        "notes",
        file("convex/a.ts", `await ctx.db.query("notes").collect();`),
      ),
    ).toEqual(["convex/a.ts:1"]);
  });

  it("resolves constants through as const, satisfies and parentheses", () => {
    const sources = [
      file(
        "convex/a.ts",
        [
          `const A = "notes" as const;`,
          `const B = ("notes" satisfies string);`,
          `await ctx.db.query(A).take(5);`,
          `await ctx.db.query((B)).collect();`,
        ].join("\n"),
      ),
    ];
    expect(queriesOn("notes", ...sources)).toEqual([
      "convex/a.ts:3",
      "convex/a.ts:4",
    ]);
  });

  it("resolves properties of constant objects and bracketed calls", () => {
    const sources = [
      file(
        "convex/a.ts",
        [
          `const TABLES = { notes: "notes", users: "users" } as const;`,
          `await ctx.db.query(TABLES.notes).collect();`,
          `await ctx.db["query"](TABLES["notes"]).collect();`,
          `await ctx.db.query(TABLES.users).collect();`,
        ].join("\n"),
      ),
    ];
    expect(queriesOn("notes", ...sources)).toEqual([
      "convex/a.ts:2",
      "convex/a.ts:3",
    ]);
  });

  it("uses an imported constant when only one file defines it", () => {
    const sources = [
      file("convex/tables.ts", `export const NOTES = "notes";`),
      file(
        "convex/search.ts",
        [`import { NOTES } from "./tables";`, `ctx.db.query(NOTES);`].join("\n"),
      ),
    ];
    expect(queriesOn("notes", ...sources)).toEqual(["convex/search.ts:2"]);
  });

  it("prefers a file's own constant over another file's with the same name", () => {
    const sources = [
      file(
        "convex/documents.ts",
        [`const T = "documents";`, `ctx.db.query(T).take(1);`].join("\n"),
      ),
      file("convex/chunks.ts", `const T = "chunks";`),
    ];
    expect(queriesOn("chunks", ...sources)).toEqual([]);
    expect(queriesOn("documents", ...sources)).toEqual([
      "convex/documents.ts:2",
    ]);
  });

  it("leaves a name defined differently in several other files unresolved", () => {
    const sources = [
      file("convex/a.ts", `const T = "chunks";`),
      file("convex/b.ts", `const T = "documents";`),
      file("convex/c.ts", `ctx.db.query(T);`),
    ];
    expect(queriesOn("chunks", ...sources)).toEqual([]);
  });

  it("ignores tables it can't resolve, other tables and function registration", () => {
    const sources = [
      file(
        "convex/a.ts",
        [
          `async function load(ctx, table) { return ctx.db.query(table).collect(); }`,
          `await ctx.db.system.query("_storage").take(10);`,
          `export const list = query({ args: {}, handler: async () => null });`,
        ].join("\n"),
      ),
    ];
    expect(queriesOn("notes", ...sources)).toEqual([]);
  });

  it("counts vector searches however they are called", () => {
    const { vectorSearchCalls } = findTableAccess(
      [
        file(
          "convex/a.ts",
          [
            `await ctx.vectorSearch("notes", "by_embedding", { vector });`,
            `const { vectorSearch } = ctx;`,
            `await vectorSearch("notes", "by_embedding", { vector });`,
          ].join("\n"),
        ),
      ],
      "notes",
    );
    expect(vectorSearchCalls).toBe(2);
  });
});
