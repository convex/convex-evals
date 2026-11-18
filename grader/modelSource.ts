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

// A property name written as `.name` or `["name"]`.
function memberName(node: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(unwrap(node.argumentExpression))
  ) {
    return (unwrap(node.argumentExpression) as ts.StringLiteralLike).text;
  }
  return undefined;
}

/**
 * String constants a file declares: `const T = "notes"` as `T`, and
 * `const TABLES = { notes: "notes" }` as `TABLES.notes`.
 */
function fileConstants(file: ts.SourceFile): Map<string, string> {
  const constants = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const value = unwrap(node.initializer);
      if (ts.isStringLiteralLike(value)) {
        constants.set(node.name.text, value.text);
      } else if (ts.isObjectLiteralExpression(value)) {
        for (const property of value.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            (ts.isIdentifier(property.name) ||
              ts.isStringLiteralLike(property.name))
          ) {
            const propertyValue = unwrap(property.initializer);
            if (ts.isStringLiteralLike(propertyValue)) {
              constants.set(
                `${node.name.text}.${property.name.text}`,
                propertyValue.text,
              );
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return constants;
}

/**
 * Where the model's code runs a vector search and where it queries `table`.
 *
 * Loading vector search hits needs only `db.get` by ID, so any query on the
 * searched table means rows are found another way, such as loading them all
 * and ranking them in JavaScript. Table names are resolved from string
 * literals and string constants (through `as const`, `satisfies` and
 * parentheses, and as properties of constant objects). A constant declared in
 * the same file wins; one from another file is used only when no other file
 * gives the same name a different value. A name that can't be resolved is
 * left alone rather than counted against the model.
 */
export function findTableAccess(
  sources: ModelSource[],
  table: string,
): { vectorSearchCalls: number; tableQueries: string[] } {
  const files = sources.map((source) =>
    ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true),
  );
  const local = new Map(files.map((file) => [file, fileConstants(file)]));

  // Values a name has across all files, for constants imported from another.
  const everywhere = new Map<string, Set<string>>();
  for (const constants of local.values()) {
    for (const [name, value] of constants) {
      if (!everywhere.has(name)) everywhere.set(name, new Set());
      everywhere.get(name)!.add(value);
    }
  }

  const resolve = (file: ts.SourceFile, node: ts.Expression | undefined) => {
    if (node === undefined) return undefined;
    const value = unwrap(node);
    if (ts.isStringLiteralLike(value)) return value.text;
    let key: string | undefined;
    if (ts.isIdentifier(value)) {
      key = value.text;
    } else {
      const object = ts.isPropertyAccessExpression(value)
        ? unwrap(value.expression)
        : ts.isElementAccessExpression(value)
          ? unwrap(value.expression)
          : undefined;
      const property = memberName(value);
      if (object !== undefined && ts.isIdentifier(object) && property) {
        key = `${object.text}.${property}`;
      }
    }
    if (key === undefined) return undefined;
    const own = local.get(file)!.get(key);
    if (own !== undefined) return own;
    const shared = everywhere.get(key);
    return shared?.size === 1 ? [...shared][0] : undefined;
  };

  let vectorSearchCalls = 0;
  const tableQueries: string[] = [];
  for (const file of files) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        const name = ts.isIdentifier(callee) ? callee.text : memberName(callee);
        if (name === "vectorSearch") {
          vectorSearchCalls++;
        }
        if (
          name === "query" &&
          !ts.isIdentifier(callee) &&
          resolve(file, node.arguments[0]) === table
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
