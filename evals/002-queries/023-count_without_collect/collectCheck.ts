import ts from "typescript";

/**
 * Whether the source calls `.collect()` on a query that may read the tickets
 * table. Collecting every ticket is what this eval rules out.
 *
 * A blanket ban on `.collect(` failed correct answers: a sharded counter
 * collects its few shard rows for an org, which stays cheap however many
 * tickets exist. So a `.collect()` is allowed only when its query provably
 * reads another table: `db.query("someOtherTable")`, directly or through a
 * variable holding the query, the table name, or an object of table names.
 * Names are resolved by scope, so two functions reusing a variable name can't
 * mask each other, and a variable that's reassigned anywhere (or an object
 * whose properties are) counts as unknown. Anything we can't trace, such as a
 * query built in a helper or a wrapper object's own `query()` method, still
 * counts as collecting tickets.
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

  // Variables assigned after their declaration, and objects whose
  // properties are, anywhere in the file. Their initializers can't be trusted.
  const reassigned = new Set<ts.Symbol>();
  const mutatedObjects = new Set<ts.Symbol>();
  const noteTarget = (target: ts.Expression): void => {
    const node = skipWrappers(target);
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol !== undefined) reassigned.add(symbol);
    } else if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const object = skipWrappers(node.expression);
      if (ts.isIdentifier(object)) {
        const symbol = checker.getSymbolAtLocation(object);
        if (symbol !== undefined) mutatedObjects.add(symbol);
      }
    } else if (ts.isArrayLiteralExpression(node)) {
      node.elements.forEach((element) =>
        noteTarget(ts.isSpreadElement(element) ? element.expression : element),
      );
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isShorthandPropertyAssignment(property))
          noteTarget(property.name);
        else if (ts.isPropertyAssignment(property))
          noteTarget(property.initializer);
        else if (ts.isSpreadAssignment(property))
          noteTarget(property.expression);
      }
    }
  };
  const findAssignments = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      noteTarget(node.left);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      noteTarget(node.operand);
    } else if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      noteTarget(node.initializer);
    }
    ts.forEachChild(node, findAssignments);
  };
  findAssignments(sourceFile);

  // The declaration this identifier refers to, if it's resolvable.
  const declarationOf = (id: ts.Identifier): ts.Declaration | undefined =>
    checker.getSymbolAtLocation(id)?.valueDeclaration;

  // The initializer of the variable this identifier refers to, if it's never
  // reassigned.
  const constInitializer = (id: ts.Identifier): ts.Expression | undefined => {
    const symbol = checker.getSymbolAtLocation(id);
    const declaration = symbol?.valueDeclaration;
    if (
      symbol === undefined ||
      declaration === undefined ||
      !ts.isVariableDeclaration(declaration) ||
      !ts.isIdentifier(declaration.name) ||
      declaration.initializer === undefined ||
      reassigned.has(symbol)
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
      const objectSymbol = checker.getSymbolAtLocation(node.expression);
      if (objectSymbol === undefined || mutatedObjects.has(objectSymbol)) {
        return undefined;
      }
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

  // `ctx.db`, or a name for it: destructured from ctx (`{ db }` or
  // `{ db: reader }`), a parameter called `db` or typed as a database reader
  // or writer, or a variable holding one of those. A variable called `db`
  // that holds something else, such as a wrapper object, doesn't count.
  const isDatabaseReader = (expr: ts.Expression, depth = 0): boolean => {
    const node = skipWrappers(expr);
    if (ts.isPropertyAccessExpression(node)) return node.name.text === "db";
    if (!ts.isIdentifier(node) || depth >= MAX_DEPTH) return false;
    const declaration = declarationOf(node);
    if (declaration === undefined) return node.text === "db";
    if (ts.isBindingElement(declaration)) {
      const bound = declaration.propertyName ?? declaration.name;
      return ts.isIdentifier(bound) && bound.text === "db";
    }
    if (ts.isParameter(declaration)) {
      return (
        node.text === "db" ||
        (declaration.type !== undefined &&
          /Database(Reader|Writer)\b|\[\s*["']db["']\s*\]/.test(
            declaration.type.getText(sourceFile),
          ))
      );
    }
    const init = constInitializer(node);
    return init !== undefined && isDatabaseReader(init, depth + 1);
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
