import { expect, test } from "vitest";
import { getLatestOutputProjectDir, readOutputFile } from "../../../grader/outputDir";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const CATEGORY = "007-components";
const EVAL_NAME = "007-choose_aggregate_range_sums";

// This is a SELECTION eval with a static pipeline (see eval.json): it
// measures what the model CHOSE, deliberately tolerant of syntax errors,
// stale versions, and API slips that the usage eval (000) grades. The
// TypeScript parser is error-recovering, so choices remain visible in the
// AST even when the code would not compile.

interface Analysis {
  dependsOnAggregate: boolean;
  mountsAggregate: boolean;
  constructsClient: boolean;
  synchronizesWrites: boolean;
  readsFromAggregate: boolean;
  usesSum: boolean;
  configuresSumValue: boolean;
  scanConstructs: string[];
}

function analyze(): Analysis {
  const projectDir = getLatestOutputProjectDir(CATEGORY, EVAL_NAME);

  let dependsOnAggregate = false;
  try {
    const packageJson = JSON.parse(
      readOutputFile(CATEGORY, EVAL_NAME, "package.json"),
    ) as { dependencies?: Record<string, string> };
    dependsOnAggregate =
      packageJson.dependencies?.["@convex-dev/aggregate"] !== undefined;
  } catch {
    // Unparseable package.json: dependency choice not visible.
  }

  const sources: ts.SourceFile[] = [];
  const load = (relativeDir: string) => {
    let entries;
    try {
      entries = readdirSync(join(projectDir, "convex", relativeDir), {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relativePath =
        relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory() && entry.name !== "_generated") {
        load(relativePath);
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const text = readFileSync(
        join(projectDir, "convex", relativePath),
        "utf-8",
      );
      sources.push(
        ts.createSourceFile(
          relativePath,
          text,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS,
        ),
      );
    }
  };
  load("");

  let mountsAggregate = false;
  let constructsClient = false;
  let synchronizesWrites = false;
  let readsFromAggregate = false;
  let usesSum = false;
  let configuresSumValue = false;
  const scanConstructs: string[] = [];

  const writeMethods = new Set([
    "insert",
    "insertIfDoesNotExist",
    "replace",
    "replaceOrInsert",
    "delete",
    "deleteIfExists",
  ]);
  // DirectAggregate writes that add an entry with its sumValue.
  const sumValueWriteMethods = new Set([
    "insert",
    "insertIfDoesNotExist",
    "replace",
    "replaceOrInsert",
  ]);
  const readMethods = new Set(["count", "indexOf", "indexOfDoc", "at", "sum"]);
  const scanMethods = new Set(["collect", "take", "filter", "paginate"]);

  for (const sourceFile of sources) {
    // Imported client constructor names from @convex-dev/aggregate.
    const clientCtors = new Set<string>();
    for (const statement of sourceFile.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const spec = statement.moduleSpecifier.text;
        if (/^@convex-dev\/aggregate\/convex\.config(?:\.js)?$/.test(spec)) {
          mountsAggregate =
            mountsAggregate || /\.use\(/.test(sourceFile.getFullText());
        }
        if (spec === "@convex-dev/aggregate") {
          const bindings = statement.importClause?.namedBindings;
          if (bindings !== undefined && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              clientCtors.add(element.name.text);
            }
          }
        }
      }
    }

    // Client instance variable names in this file. Unwrap parens and
    // as-casts (e.g. `new Aggregate(...) as unknown as X`).
    const unwrap = (expression: ts.Expression): ts.Expression => {
      let current = expression;
      while (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current)
      ) {
        current = current.expression;
      }
      return current;
    };
    // A one-file program, only so the checker can resolve each identifier
    // to the declaration in scope. Imports stay unresolved, which is fine.
    const checker = ts
      .createProgram({
        rootNames: [sourceFile.fileName],
        options: { noLib: true, noResolve: true, types: [] },
        host: {
          getSourceFile: (name) =>
            name === sourceFile.fileName ? sourceFile : undefined,
          getDefaultLibFileName: () => "lib.d.ts",
          writeFile: () => {},
          getCurrentDirectory: () => "/",
          getCanonicalFileName: (name) => name,
          useCaseSensitiveFileNames: () => true,
          getNewLine: () => "\n",
          fileExists: (name) => name === sourceFile.fileName,
          readFile: () => undefined,
        },
      })
      .getTypeChecker();
    const unwrapAll = (expression: ts.Expression): ts.Expression => {
      let current = expression;
      while (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isSatisfiesExpression(current) ||
        ts.isNonNullExpression(current) ||
        ts.isTypeAssertionExpression(current)
      ) {
        current = current.expression;
      }
      return current;
    };
    const declarationOf = (
      identifier: ts.Identifier,
    ): ts.Declaration | undefined =>
      checker.getSymbolAtLocation(identifier)?.valueDeclaration;
    // Whether a sumValue is worked out from the transaction's amount, so the
    // aggregate sums amounts. A fixed number counts rows, and another field
    // such as `happenedAt` sums the wrong thing. A parameter gets the benefit
    // of the doubt, as its value can't be traced.
    const mentionsAmount = (node: ts.Node): boolean =>
      ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
        /amount/i.test(node.text)) ||
      ts.forEachChild(node, mentionsAmount) === true;
    const declarationCarriesAmount = (
      declaration: ts.Declaration | undefined,
      depth: number,
    ): boolean => {
      if (declaration === undefined) return false;
      if (ts.isParameter(declaration)) return true;
      if (ts.isBindingElement(declaration)) {
        return mentionsAmount(declaration.propertyName ?? declaration.name);
      }
      return (
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer !== undefined &&
        carriesAmount(declaration.initializer, depth + 1)
      );
    };
    const carriesAmount = (expression: ts.Expression, depth = 0): boolean => {
      const value = unwrapAll(expression);
      if (mentionsAmount(value)) return true;
      if (depth >= 5) return false;
      if (ts.isIdentifier(value)) {
        return declarationCarriesAmount(declarationOf(value), depth);
      }
      // `sumValue: weightOf(tx)` with a selector declared in this file.
      if (ts.isCallExpression(value)) {
        const callee = unwrapAll(value.expression);
        const declaration = ts.isIdentifier(callee)
          ? declarationOf(callee)
          : undefined;
        if (declaration === undefined) return false;
        if (ts.isFunctionDeclaration(declaration)) {
          return (
            declaration.body !== undefined && mentionsAmount(declaration.body)
          );
        }
        return (
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer !== undefined &&
          carriesAmount(declaration.initializer, depth + 1)
        );
      }
      return false;
    };
    // A fixed number (`1`, `() => 1`, or a const holding one) counts rows
    // instead of summing amounts.
    const isFixedNumber = (expression: ts.Expression, depth = 0): boolean => {
      let current = unwrapAll(expression);
      if (ts.isIdentifier(current)) {
        const declaration = depth < 5 ? declarationOf(current) : undefined;
        return (
          declaration !== undefined &&
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer !== undefined &&
          isFixedNumber(declaration.initializer, depth + 1)
        );
      }
      if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
        const body = current.body;
        if (!ts.isBlock(body)) {
          current = unwrapAll(body);
        } else {
          const only =
            body.statements.length === 1 ? body.statements[0] : undefined;
          if (
            only === undefined ||
            !ts.isReturnStatement(only) ||
            only.expression === undefined
          ) {
            return false;
          }
          current = unwrapAll(only.expression);
        }
      }
      return (
        ts.isNumericLiteral(current) ||
        (ts.isPrefixUnaryExpression(current) &&
          ts.isNumericLiteral(current.operand))
      );
    };
    // Whether an object sets a sumValue. A constructor option counts unless
    // it's a fixed number: this eval tolerates API slips there, as the usage
    // eval grades those. A DirectAggregate entry's sumValue (`strict`) must
    // come from the amount, since it's the only place the sum is configured.
    const setsSumValue = (
      object: ts.ObjectLiteralExpression,
      strict: boolean,
    ): boolean =>
      object.properties.some((property) => {
        if (
          property.name === undefined ||
          !ts.isIdentifier(property.name) ||
          property.name.text !== "sumValue"
        ) {
          return false;
        }
        if (ts.isPropertyAssignment(property)) {
          return strict
            ? carriesAmount(property.initializer)
            : !isFixedNumber(property.initializer);
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          // `{ sumValue }`: the variable it reads, not the property.
          const declaration =
            checker.getShorthandAssignmentValueSymbol(
              property,
            )?.valueDeclaration;
          if (strict) return declarationCarriesAmount(declaration, 0);
          return !(
            declaration !== undefined &&
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer !== undefined &&
            isFixedNumber(declaration.initializer)
          );
        }
        if (
          !(
            ts.isMethodDeclaration(property) ||
            ts.isGetAccessorDeclaration(property)
          ) ||
          property.body === undefined
        ) {
          return false;
        }
        if (strict) return mentionsAmount(property.body);
        // `sumValue() { return 1; }` counts rows, like `() => 1`.
        const only =
          property.body.statements.length === 1
            ? property.body.statements[0]
            : undefined;
        return !(
          only !== undefined &&
          ts.isReturnStatement(only) &&
          only.expression !== undefined &&
          isFixedNumber(only.expression)
        );
      });
    // The object a write is given, inline or through a variable in scope.
    const objectArgument = (
      argument: ts.Expression,
      depth = 0,
    ): ts.ObjectLiteralExpression | undefined => {
      const value = unwrapAll(argument);
      if (ts.isObjectLiteralExpression(value)) return value;
      if (!ts.isIdentifier(value) || depth >= 5) return undefined;
      const declaration = declarationOf(value);
      return declaration !== undefined &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer !== undefined
        ? objectArgument(declaration.initializer, depth + 1)
        : undefined;
    };

    const clientVars = new Set<string>();
    const collectVars = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined
      ) {
        const initializer = unwrap(node.initializer);
        if (
          ts.isNewExpression(initializer) &&
          ts.isIdentifier(initializer.expression) &&
          clientCtors.has(initializer.expression.text)
        ) {
          const firstArg = initializer.arguments?.[0];
          if (
            firstArg !== undefined &&
            firstArg.getText().startsWith("components.")
          ) {
            constructsClient = true;
            clientVars.add(node.name.text);
            const options = initializer.arguments?.[1];
            const optionsObject =
              options === undefined ? undefined : objectArgument(options);
            if (
              optionsObject !== undefined &&
              setsSumValue(optionsObject, false)
            ) {
              configuresSumValue = true;
            }
          }
        }
      }
      ts.forEachChild(node, collectVars);
    };
    collectVars(sourceFile);

    const chainQueriesScores = (call: ts.CallExpression): boolean => {
      let current: ts.Expression = call;
      let boundedByUser = false;
      let queriesScores = false;
      while (
        ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression)
      ) {
        const name = current.expression.name.text;
        const arg = current.arguments[0];
        if (
          name === "query" &&
          arg !== undefined &&
          ts.isStringLiteralLike(arg) &&
          arg.text === "transactions"
        ) {
          queriesScores = true;
        }
        if (
          name === "withIndex" &&
          arg !== undefined &&
          ts.isStringLiteralLike(arg) &&
          arg.text === "__none__"
        ) {
          boundedByUser = true;
        }
        current = current.expression.expression;
      }
      return queriesScores && !boundedByUser;
    };

    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const name = node.expression.name.text;
        const receiver = node.expression.expression;
        if (ts.isIdentifier(receiver) && clientVars.has(receiver.text)) {
          if (writeMethods.has(name)) synchronizesWrites = true;
          // DirectAggregate has no sumValue option in its constructor: the
          // writes that add an entry pass `{ key, id, sumValue }` instead.
          // Count that as configuring the sum, as the TableAggregate option
          // is, when the value comes from the amount.
          // The entry being added is the last argument: `insert(ctx, entry)`,
          // `replace(ctx, old, entry)`, or the same with `ctx` left out.
          const entry = sumValueWriteMethods.has(name)
            ? node.arguments[node.arguments.length - 1]
            : undefined;
          const entryObject =
            entry === undefined ? undefined : objectArgument(entry);
          if (entryObject !== undefined && setsSumValue(entryObject, true)) {
            configuresSumValue = true;
          }
          if (readMethods.has(name)) readsFromAggregate = true;
          if (name === "sum") usesSum = true;
        }
        // Direct component calls also count as wiring: invocation STYLE is
        // an API detail the docs-equipped usage eval grades, not this one.
        if (
          (name === "runMutation" || name === "runQuery") &&
          node.arguments.length >= 1 &&
          node.arguments[0].getText().startsWith("components.aggregate.")
        ) {
          if (name === "runMutation") synchronizesWrites = true;
          if (name === "runQuery") readsFromAggregate = true;
          constructsClient = constructsClient || true;
        }
        if (scanMethods.has(name) && chainQueriesScores(node)) {
          scanConstructs.push(`${sourceFile.fileName}: unbounded transactions .${name}()`);
        }
      }
      if (
        ts.isForOfStatement(node) &&
        node.awaitModifier !== undefined &&
        ts.isCallExpression(node.expression) &&
        chainQueriesScores(node.expression)
      ) {
        scanConstructs.push(`${sourceFile.fileName}: unbounded transactions for-await`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return {
    dependsOnAggregate,
    mountsAggregate,
    constructsClient,
    synchronizesWrites,
    readsFromAggregate,
    usesSum,
    configuresSumValue,
    scanConstructs,
  };
}

const analysis = analyze();

test("chooses the aggregate component as a dependency", () => {
  expect(analysis.dependsOnAggregate).toBe(true);
});

test("mounts the component in the app config", () => {
  expect(analysis.mountsAggregate).toBe(true);
});

test("wires the component (client class or direct calls)", () => {
  expect(analysis.constructsClient).toBe(true);
});

test("synchronizes aggregate writes alongside table writes", () => {
  expect(analysis.synchronizesWrites).toBe(true);
});

test("serves range-sum reads with the aggregate sum() API", () => {
  expect(analysis.usesSum).toBe(true);
});

test("configures sumValue so sums aggregate the amount", () => {
  expect(analysis.configuresSumValue).toBe(true);
});

test("does not fall back to scanning the scores table", () => {
  expect(analysis.scanConstructs).toEqual([]);
});
