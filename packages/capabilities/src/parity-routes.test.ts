import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { PARITY_MANIFEST } from "./parity-manifest.js";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

describe("capability REST parity", () => {
  it("only maps routes that exist in the API source", () => {
    const routeDirectory = fileURLToPath(new URL("../../../apps/api/src/routes/", import.meta.url));
    const knownRoutes = new Set<string>();
    for (const name of readdirSync(routeDirectory)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      const source = readFileSync(path.join(routeDirectory, name), "utf8");
      const sourceFile = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
      collectFastifyRoutes(sourceFile, knownRoutes);
    }

    const missing = PARITY_MANIFEST.flatMap((entry) => entry.rest)
      .filter((route) => !knownRoutes.has(route));
    expect(missing).toEqual([]);
  });
});

function collectFastifyRoutes(sourceFile: ts.SourceFile, routes: Set<string>): void {
  const visit = (node: ts.Node, aliases: ReadonlyMap<string, readonly string[]>): void => {
    if (
      ts.isForOfStatement(node)
      && ts.isVariableDeclarationList(node.initializer)
      && node.initializer.declarations.length === 1
      && ts.isIdentifier(node.initializer.declarations[0]!.name)
      && ts.isArrayLiteralExpression(node.expression)
    ) {
      const values = node.expression.elements.flatMap((element) => ts.isStringLiteralLike(element) ? [element.text] : []);
      const declaration = node.initializer.declarations[0]!;
      if (ts.isIdentifier(declaration.name)) {
        visit(node.statement, new Map([...aliases, [declaration.name.text, values]]));
      }
      return;
    }
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === "server"
      && HTTP_METHODS.has(node.expression.name.text)
    ) {
      const routeArgument = node.arguments[0];
      const routeValues = routeArgument && ts.isStringLiteralLike(routeArgument)
        ? [routeArgument.text]
        : routeArgument && ts.isIdentifier(routeArgument)
          ? aliases.get(routeArgument.text) ?? []
          : [];
      for (const route of routeValues) {
        if (route === "/health" || route.startsWith("/api/")) {
          routes.add(`${node.expression.name.text.toUpperCase()} ${route}`);
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, aliases));
  };
  visit(sourceFile, new Map());
}
