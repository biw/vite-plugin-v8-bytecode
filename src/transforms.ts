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
 * Babel plugin that converts template literals to string concatenation
 * This is REQUIRED for V8 bytecode compatibility - template literals don't work in cached bytecode
 */
function templateLiteralToConcatPlugin(api: typeof babel): PluginObj {
  const { types: t } = api;

  return {
    name: "template-literal-to-concat",
    visitor: {
      TemplateLiteral(path) {
        const { quasis, expressions } = path.node;

        // Build string concatenation
        let result: babel.types.Expression | null = null;

        for (let i = 0; i < quasis.length; i++) {
          const quasi = quasis[i];
          const expr = expressions[i];

          // Add the template string part
          if (quasi.value.cooked) {
            const stringLiteral = t.stringLiteral(quasi.value.cooked);
            result = result
              ? t.binaryExpression("+", result, stringLiteral)
              : stringLiteral;
          }

          // Add the expression part (if exists)
          // Template literal expressions are always Expression type, not TSType
          if (expr && t.isExpression(expr)) {
            result = result ? t.binaryExpression("+", result, expr) : expr;
          }
        }

        // Replace with concatenated result or empty string
        if (result) {
          path.replaceWith(result);
        } else {
          path.replaceWith(t.stringLiteral(""));
        }
      },
    },
  };
}

/**
 * Transforms code using Babel with template literal conversion and optional string protection
 * Template literal conversion is ALWAYS applied for bytecode compatibility
 */
export function transformCode(
  code: string,
  protectedStrings: string[],
  sourceMaps: boolean = false
): { code: string; map?: SourceMapInput } | null {
  const plugins: babel.PluginItem[] = [
    // ALWAYS convert template literals for bytecode compatibility
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
