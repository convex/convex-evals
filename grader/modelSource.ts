import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { getLatestOutputProjectDir } from "./outputDir.js";

export type ModelSource = { path: string; text: string };

/** The model's Convex source files, excluding generated code and tests. */
export function readModelConvexSources(
  category: string,
  name: string,
): ModelSource[] {
  const projectDir = getLatestOutputProjectDir(category, name);
  const sources: ModelSource[] = [];
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

// Strips wrappers that don't change a value: `x as const`, `x satisfies T`,
// `(x)`, `<T>x` and `x!`.
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

/**
 * Where the model's code runs a vector search and where it queries `table`.
 *
 * Loading vector search hits needs only `db.get` by ID, so any query on the
 * searched table means rows are found another way, such as loading them all
 * and ranking them in JavaScript. Table names written as string literals or
 * as string constants (in any of the model's files, through `as const`,
 * `satisfies` or parentheses) are resolved; a name that can't be resolved is
 * left alone rather than counted against the model.
 */
export function findTableAccess(
  sources: ModelSource[],
  table: string,
): { vectorSearchCalls: number; tableQueries: string[] } {
  const files = sources.map((source) =>
    ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true),
  );

  // String constants from every file, so an imported constant resolves too.
  const constants = new Map<string, string>();
  const collectConstants = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const value = unwrap(node.initializer);
      if (ts.isStringLiteralLike(value)) {
        constants.set(node.name.text, value.text);
      }
    }
    ts.forEachChild(node, collectConstants);
  };
  files.forEach(collectConstants);

  const tableName = (node: ts.Expression | undefined) => {
    if (node === undefined) return undefined;
    const value = unwrap(node);
    if (ts.isStringLiteralLike(value)) return value.text;
    if (ts.isIdentifier(value)) return constants.get(value.text);
    return undefined;
  };

  let vectorSearchCalls = 0;
  const tableQueries: string[] = [];
  for (const file of files) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        const name = ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ts.isIdentifier(callee)
            ? callee.text
            : undefined;
        if (name === "vectorSearch") {
          vectorSearchCalls++;
        }
        if (
          name === "query" &&
          ts.isPropertyAccessExpression(callee) &&
          tableName(node.arguments[0]) === table
        ) {
          const { line } = file.getLineAndCharacterOfPosition(node.getStart());
          tableQueries.push(`${file.fileName}:${line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return { vectorSearchCalls, tableQueries };
}
