import * as babel from "@babel/core";
import type { PluginObj, PluginPass } from "@babel/core";
import type { SourceMapInput } from "rollup";

interface ProtectStringsPluginState extends PluginPass {
  opts: { protectedStrings: Set<string> };
}

/**
 * Babel plugin that protects specific strings by converting them to String.fromCharCode calls
 * This adds an extra layer of obfuscation on top of bytecode compilation
 */
function protectStringsPlugin(
  api: typeof babel
): PluginObj<ProtectStringsPluginState> {
  const { types: t } = api;

  function createFromCharCodeFunction(
    value: string
  ): babel.types.CallExpression {
    const charCodes = Array.from(value).map((s) => s.charCodeAt(0));
    const charCodeLiterals = charCodes.map((code) => t.numericLiteral(code));

    // String.fromCharCode
    const memberExpression = t.memberExpression(
      t.identifier("String"),
      t.identifier("fromCharCode")
    );
    // String.fromCharCode(...arr)
    const callExpression = t.callExpression(memberExpression, [
      t.spreadElement(t.identifier("arr")),
    ]);
    // return String.fromCharCode(...arr)
    const returnStatement = t.returnStatement(callExpression);
    // function (arr) { return ... }
    const functionExpression = t.functionExpression(
      null,
      [t.identifier("arr")],
      t.blockStatement([returnStatement])
    );

    // (function(...) { ... })([x, x, x])
    return t.callExpression(functionExpression, [
      t.arrayExpression(charCodeLiterals),
    ]);
  }

  return {
    name: "protect-strings-plugin",
    visitor: {
      StringLiteral(path, state) {
        // Skip obj['property']
        if (
          path.parentPath.isMemberExpression({
            property: path.node,
            computed: true,
          })
        ) {
          return;
        }

        // Skip { 'key': value }
        if (
          path.parentPath.isObjectProperty({ key: path.node, computed: false })
        ) {
          return;
        }

        // Skip require('fs')
        if (
          path.parentPath.isCallExpression() &&
          t.isIdentifier(path.parentPath.node.callee) &&
          path.parentPath.node.callee.name === "require" &&
          path.parentPath.node.arguments[0] === path.node
        ) {
          return;
        }

        // Only CommonJS is supported for Node.js 22+, import/export checks are ignored

        const { value } = path.node;
        if (state.opts.protectedStrings.has(value)) {
          path.replaceWith(createFromCharCodeFunction(value));
        }
      },
      TemplateLiteral(path, state) {
        if (path.parentPath.isTaggedTemplateExpression({ quasi: path.node })) {
          return;
        }

        // Must be a pure static template literal
        // expressions must be empty (no ${variables})
        // quasis must have only one element (meaning the entire string is a single static part)
        if (path.node.expressions.length > 0 || path.node.quasis.length !== 1) {
          return;
        }

        // Extract the cooked value of the template literal
        const value = path.node.quasis[0].value.cooked;
        if (value && state.opts.protectedStrings.has(value)) {
          path.replaceWith(createFromCharCodeFunction(value));
        }
      },
    },
  };
}

/**
 * Babel plugin that converts untagged template literals to string concatenation.
 * Tagged templates must be preserved because their template object is observable.
 */
function templateLiteralToConcatPlugin(api: typeof babel): PluginObj {
  const { types: t } = api;

  return {
    name: "template-literal-to-concat",
    visitor: {
      TemplateLiteral(path) {
        // A tag receives the template object and substitutions separately.
        // Replacing its quasi would both invalidate the AST and change semantics.
        if (path.parentPath.isTaggedTemplateExpression({ quasi: path.node })) {
          return;
        }

        const { quasis, expressions } = path.node;

        // Chained String#concat calls preserve template-literal coercion and
        // evaluation order. In particular, each expression is converted with
        // a string hint before the following expression is evaluated.
        let result: babel.types.Expression = t.stringLiteral(
          quasis[0]?.value.cooked ?? ""
        );

        for (let i = 0; i < expressions.length; i++) {
          const expr = expressions[i];
          if (!t.isExpression(expr)) {
            continue;
          }

          const nextQuasi = quasis[i + 1]?.value.cooked ?? "";
          result = t.callExpression(
            t.memberExpression(result, t.identifier("concat")),
            [expr, t.stringLiteral(nextQuasi)]
          );
        }

        path.replaceWith(result);
      },
    },
  };
}

/**
 * Transforms code using Babel with untagged template literal conversion and
 * optional string protection.
 */
export function transformCode(
  code: string,
  protectedStrings: string[],
  sourceMaps: boolean = false
): { code: string; map?: SourceMapInput } | null {
  const plugins: babel.PluginItem[] = [
    // Convert ordinary template literals while preserving tagged templates.
    templateLiteralToConcatPlugin,
  ];

  // Add string protection if needed
  if (protectedStrings.length > 0) {
    plugins.push([
      protectStringsPlugin,
      { protectedStrings: new Set(protectedStrings) },
    ]);
  }

  const result = babel.transformSync(code, {
    plugins,
    sourceMaps,
    configFile: false,
    babelrc: false,
  });

  return result
    ? { code: result.code || "", map: result.map || undefined }
    : null;
}
