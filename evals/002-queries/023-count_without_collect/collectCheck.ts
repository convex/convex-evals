import ts from "typescript";

/**
 * Whether the source calls `.collect()` on a query that may read the tickets
 * table. Collecting every ticket is what this eval rules out.
 *
 * A blanket ban on `.collect(` failed correct answers: a sharded counter
 * collects its few shard rows for an org, which stays cheap however many
 * tickets exist. So a `.collect()` is allowed only when its query provably
 * reads another table: `db.query("someOtherTable")`, directly or through a
 * `const` holding the query, the table name, or an object of table names.
 * Names are resolved by scope, so two functions reusing a variable name can't
 * mask each other, and a `let` or `var` counts as unknown because it can be
 * reassigned. Anything we can't trace, such as a query built in a helper or a
 * wrapper object's own `query()` method, still counts as collecting tickets.
 *
 * Known gap: a model that mirrors every ticket into a second table (one row
 * per ticket, say a `{ orgId, delta: 1 }` row) and collects that would pass
 * this check. That's no better than collecting tickets, but no observed
 * answer has done it.
 */
export function collectsTicketsTable(sourceText: string): boolean {
  const fileName = "/answer/convex/index.ts";
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  // A one-file program, only so the checker can resolve each identifier to
  // the declaration in scope. Imports stay unresolved, which is fine here.
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === fileName ? sourceFile : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === fileName,
    readFile: () => undefined,
  };
  const checker = ts
    .createProgram({
      rootNames: [fileName],
      options: { noLib: true, noResolve: true, types: [] },
      host,
    })
    .getTypeChecker();

  const skipWrappers = (expr: ts.Expression): ts.Expression => {
    let node = expr;
    while (
      ts.isAwaitExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node)
    ) {
      node = node.expression;
    }
    return node;
  };

  // The initializer of the `const` this identifier refers to, if any.
  const constInitializer = (id: ts.Identifier): ts.Expression | undefined => {
    const declaration = checker.getSymbolAtLocation(id)?.valueDeclaration;
    if (
      declaration === undefined ||
      !ts.isVariableDeclaration(declaration) ||
      !ts.isIdentifier(declaration.name) ||
      declaration.initializer === undefined ||
      (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0
    ) {
      return undefined;
    }
    return declaration.initializer;
  };

  const MAX_DEPTH = 5;

  const stringValue = (expr: ts.Expression, depth = 0): string | undefined => {
    const node = skipWrappers(expr);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (depth >= MAX_DEPTH) return undefined;
    if (ts.isIdentifier(node)) {
      const init = constInitializer(node);
      return init === undefined ? undefined : stringValue(init, depth + 1);
    }
    // `TABLES.counters` where `const TABLES = { counters: "..." }`.
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression)
    ) {
      const init = constInitializer(node.expression);
      const object = init === undefined ? undefined : skipWrappers(init);
      if (object === undefined || !ts.isObjectLiteralExpression(object)) {
        return undefined;
      }
      const property = object.properties.find(
        (candidate) =>
          ts.isPropertyAssignment(candidate) &&
          (ts.isIdentifier(candidate.name) ||
            ts.isStringLiteralLike(candidate.name)) &&
          candidate.name.text === node.name.text,
      );
      return property !== undefined && ts.isPropertyAssignment(property)
        ? stringValue(property.initializer, depth + 1)
        : undefined;
    }
    return undefined;
  };

  // `ctx.db`, a parameter or binding named `db`, or a const alias of either.
  const isDatabaseReader = (expr: ts.Expression, depth = 0): boolean => {
    const node = skipWrappers(expr);
    if (ts.isPropertyAccessExpression(node)) return node.name.text === "db";
    if (ts.isIdentifier(node)) {
      if (node.text === "db") return true;
      if (depth >= MAX_DEPTH) return false;
      const init = constInitializer(node);
      return init !== undefined && isDatabaseReader(init, depth + 1);
    }
    return false;
  };

  // Walk down a call chain like `ctx.db.query("t").withIndex(...).collect()`
  // to the `db.query(<table>)` call and return the table name if it's known.
  const tableOf = (expr: ts.Expression, depth = 0): string | undefined => {
    let node = skipWrappers(expr);
    for (;;) {
      if (ts.isCallExpression(node)) {
        const callee = skipWrappers(node.expression);
        if (!ts.isPropertyAccessExpression(callee)) return undefined;
        if (callee.name.text === "query") {
          return isDatabaseReader(callee.expression) &&
            node.arguments.length > 0
            ? stringValue(node.arguments[0])
            : undefined;
        }
        node = skipWrappers(callee.expression);
      } else if (ts.isPropertyAccessExpression(node)) {
        node = skipWrappers(node.expression);
      } else if (ts.isIdentifier(node) && depth < MAX_DEPTH) {
        const init = constInitializer(node);
        return init === undefined ? undefined : tableOf(init, depth + 1);
      } else {
        return undefined;
      }
    }
  };

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "collect"
    ) {
      const table = tableOf(node.expression.expression);
      if (table === undefined || table === "tickets") {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}
