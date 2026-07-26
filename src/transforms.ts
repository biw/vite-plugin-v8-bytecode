import * as babel from "@babel/core";
import type { PluginObj, PluginPass } from "@babel/core";
import MagicString from "magic-string";
import type { SourceMapInput } from "rollup";

interface ProtectStringsPluginState extends PluginPass {
  opts: { protectedStrings: Set<string> };
}

const CHAR_CODE_CHUNK_SIZE = 4096;

/**
 * Babel plugin that protects specific strings by converting them to String.fromCharCode calls
 * This adds an extra layer of obfuscation on top of bytecode compilation
 */
function protectStringsPlugin(
  api: typeof babel
): PluginObj<ProtectStringsPluginState> {
  const { types: t } = api;

  function createFromCharCodeFunction(
    path: babel.NodePath,
    value: string
  ): babel.types.Expression {
    const program = path.findParent((parent) => parent.isProgram());
    if (!program?.isProgram()) {
      throw path.buildCodeFrameError(
        "Protected strings must be contained in a JavaScript program"
      );
    }

    const helper = program.scope.generateUidIdentifier("fromCharCode");
    const stringConstructor = program.scope.generateUidIdentifier("String");
    const fromCharCode = program.scope.generateUidIdentifier("fromCharCode");
    const characterCodes = program.scope.generateUidIdentifier("characterCodes");

    // Capture the intrinsic before any user code can shadow or replace String.
    // One capture is emitted per protected literal so the generated code still
    // makes each protected value independently identifiable.
    program.unshiftContainer(
      "body",
      t.variableDeclaration("const", [
        t.variableDeclarator(
          helper,
          t.callExpression(
            t.functionExpression(
              null,
              [stringConstructor, fromCharCode],
              t.blockStatement([
                t.returnStatement(
                  t.functionExpression(
                    null,
                    [t.restElement(characterCodes)],
                    t.blockStatement([
                      t.returnStatement(
                        t.callExpression(
                          t.memberExpression(
                            fromCharCode,
                            t.identifier("apply")
                          ),
                          [stringConstructor, characterCodes]
                        )
                      ),
                    ])
                  )
                ),
              ])
            ),
            [
              t.memberExpression(
                t.identifier("globalThis"),
                t.identifier("String")
              ),
              t.memberExpression(
                t.memberExpression(
                  t.identifier("globalThis"),
                  t.identifier("String")
                ),
                t.identifier("fromCharCode")
              ),
            ]
          )
        ),
      ])
    );

    const charCodes: number[] = [];
    for (let index = 0; index < value.length; index++) {
      charCodes.push(value.charCodeAt(index));
    }

    const calls: babel.types.CallExpression[] = [];
    for (let index = 0; index < charCodes.length; index += CHAR_CODE_CHUNK_SIZE) {
      calls.push(
        t.callExpression(
          t.cloneNode(helper),
          charCodes
            .slice(index, index + CHAR_CODE_CHUNK_SIZE)
            .map((code) => t.numericLiteral(code))
        )
      );
    }

    if (calls.length === 0) {
      return t.callExpression(t.cloneNode(helper), []);
    }

    return calls.slice(1).reduce<babel.types.Expression>(
      (result, call) => t.binaryExpression("+", result, call),
      calls[0]
    );
  }

  function isNonComputedPropertyKey(path: babel.NodePath): boolean {
    const parent = path.parentPath;
    if (!parent) {
      return false;
    }

    if (
      parent.isObjectProperty() ||
      parent.isObjectMethod() ||
      parent.isClassMethod() ||
      parent.isClassProperty() ||
      parent.isClassAccessorProperty()
    ) {
      return parent.node.key === path.node && !parent.node.computed;
    }

    return false;
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

        // Skip object/class property, method, and accessor names.
        if (isNonComputedPropertyKey(path)) {
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
          path.replaceWith(createFromCharCodeFunction(path, value));
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
          path.replaceWith(createFromCharCodeFunction(path, value));
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

  function captureConcat(path: babel.NodePath): babel.types.Identifier {
    const program = path.findParent((parent) => parent.isProgram());
    if (!program?.isProgram()) {
      throw path.buildCodeFrameError(
        "Template literals must be contained in a JavaScript program"
      );
    }

    const helper = program.scope.generateUidIdentifier("concat");
    program.unshiftContainer(
      "body",
      t.variableDeclaration("const", [
        t.variableDeclarator(
          helper,
          t.memberExpression(
            t.memberExpression(
              t.memberExpression(
                t.identifier("globalThis"),
                t.identifier("String")
              ),
              t.identifier("prototype")
            ),
            t.identifier("concat")
          )
        ),
      ])
    );
    return helper;
  }

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
        const concat = expressions.length > 0 ? captureConcat(path) : null;

        // Use an own concat method backed by the captured intrinsic. This
        // preserves template-literal coercion and evaluation order without
        // consulting a possibly replaced String.prototype.concat at runtime.
        let result: babel.types.Expression = t.stringLiteral(
          quasis[0]?.value.cooked ?? ""
        );

        for (let i = 0; i < expressions.length; i++) {
          const expr = expressions[i];
          if (!t.isExpression(expr)) {
            continue;
          }

          const nextQuasi = quasis[i + 1]?.value.cooked ?? "";
          const boundConcat = t.callExpression(
            t.memberExpression(t.cloneNode(concat!), t.identifier("bind")),
            [result]
          );
          result = t.callExpression(
            t.memberExpression(
              t.objectExpression([
                t.objectProperty(t.identifier("concat"), boundConcat),
              ]),
              t.identifier("concat")
            ),
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
    sourceType: "script",
    parserOpts: {
      allowReturnOutsideFunction: true,
      allowNewTargetOutsideFunction: true,
    },
    configFile: false,
    babelrc: false,
  });

  return result
    ? { code: result.code || "", map: result.map || undefined }
    : null;
}

export function rewriteRequireSpecifiers(
  code: string,
  replace: (specifier: string) => string | undefined
): { code: string; rewritten: boolean } {
  const replacements: Array<{ start: number; end: number; value: string }> = [];

  babel.transformSync(code, {
    code: false,
    ast: false,
    sourceType: "script",
    parserOpts: {
      allowReturnOutsideFunction: true,
      allowNewTargetOutsideFunction: true,
    },
    configFile: false,
    babelrc: false,
    plugins: [
      () => ({
        visitor: {
          CallExpression(path: babel.NodePath<babel.types.CallExpression>) {
            if (
              !tIsUnboundRequire(path) ||
              path.node.arguments.length !== 1 ||
              !babel.types.isStringLiteral(path.node.arguments[0])
            ) {
              return;
            }

            const argument = path.node.arguments[0];
            const replacement = replace(argument.value);
            if (
              replacement === undefined ||
              replacement === argument.value ||
              argument.start == null ||
              argument.end == null
            ) {
              return;
            }

            replacements.push({
              start: argument.start,
              end: argument.end,
              value: replacement,
            });
          },
        },
      }),
    ],
  });

  if (replacements.length === 0) {
    return { code, rewritten: false };
  }

  const rewrittenCode = new MagicString(code);
  for (const replacement of replacements) {
    rewrittenCode.overwrite(
      replacement.start,
      replacement.end,
      JSON.stringify(replacement.value)
    );
  }

  return { code: rewrittenCode.toString(), rewritten: true };
}

function tIsUnboundRequire(
  path: babel.NodePath<babel.types.CallExpression>
): boolean {
  return (
    babel.types.isIdentifier(path.node.callee, { name: "require" }) &&
    !path.scope.hasBinding("require")
  );
}
