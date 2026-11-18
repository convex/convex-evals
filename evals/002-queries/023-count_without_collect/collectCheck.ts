import ts from "typescript";

/**
 * Whether the source calls `.collect()` on a query that may read the tickets
 * table. Collecting every ticket is what this eval rules out.
 *
 * A blanket ban on `.collect(` failed correct answers: a sharded counter
 * collects its few shard rows for an org, which stays cheap however many
 * tickets exist. So a `.collect()` is allowed only when its query provably
 * reads another table (`db.query("someOtherTable")`, directly, through a
 * local variable, or through a string constant). Anything we can't trace,
 * such as a query built in a helper, still counts as collecting tickets.
 *
 * Known gap: a model that mirrors every ticket into a second table and
 * collects that would pass this check. That's no better than collecting
 * tickets, but no observed answer has done it.
 */
export function collectsTicketsTable(sourceText: string): boolean {
  const sourceFile = ts.createSourceFile(
    "convex/index.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  // Every `const name = <initializer>` in the file, for following a query
  // chain or a table name constant through a local variable.
  const initializers = new Map<string, ts.Expression>();
  const collectDeclarations = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      initializers.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(sourceFile);

  const stringValue = (expr: ts.Expression, depth = 0): string | undefined => {
    if (ts.isStringLiteralLike(expr)) return expr.text;
    if (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr))
      return stringValue(expr.expression, depth);
    if (ts.isIdentifier(expr) && depth < 3) {
      const init = initializers.get(expr.text);
      return init ? stringValue(init, depth + 1) : undefined;
    }
    return undefined;
  };

  // Walk down a call chain like `ctx.db.query("t").withIndex(...).collect()`
  // to the `.query(<table>)` call and return the table name if it's known.
  const tableOf = (expr: ts.Expression, depth = 0): string | undefined => {
    let node: ts.Expression = expr;
    for (;;) {
      if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)) {
        node = node.expression;
      } else if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "query" &&
          node.arguments.length > 0
        ) {
          return stringValue(node.arguments[0]);
        }
        node = callee;
      } else if (ts.isPropertyAccessExpression(node)) {
        node = node.expression;
      } else if (ts.isIdentifier(node) && depth < 3) {
        const init = initializers.get(node.text);
        return init ? tableOf(init, depth + 1) : undefined;
      } else {
        return undefined;
      }
    }
  };

  let found = false;
  const visit = (node: ts.Node) => {
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
