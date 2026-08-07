import type { ParserOptions, Rolldown } from "vite";

type ParseAst = (
  input: string,
  options?: (ParserOptions & { allowReturnOutsideFunction?: boolean }) | null,
) => unknown;
type SourceMapInput = Rolldown.SourceMapInput;

type JavaScriptNode = {
  end: number;
  start: number;
  type: string;
  [key: string]: unknown;
};

type ParentNode = {
  key: string;
  node: JavaScriptNode;
};

type SourceEdit = {
  content: string;
  end: number;
  literalValue?: string;
  mapToStart?: number;
  start: number;
};

type MappingPoint = {
  generatedColumn: number;
  generatedLine: number;
  originalColumn: number;
  originalLine: number;
};

type Scope = {
  bindings: Set<string>;
  functionScope: boolean;
  parent: Scope | null;
};

const BASE64_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CHAR_CODE_CHUNK_SIZE = 4096;

/**
 * Obfuscates selected literal values without bringing a second JavaScript
 * parser into the build. Vite exposes Rollup's parser through the plugin
 * context, so callers pass `this.parse`.
 */
export function transformCode(
  code: string,
  obfuscatedStrings: string[],
  parse: ParseAst,
  sourceMaps: boolean = false,
  sourceFileName: string = "chunk.js",
): { code: string; map?: SourceMapInput } | null {
  if (obfuscatedStrings.length === 0) {
    return null;
  }

  const ast = asJavaScriptNode(parse(code, { allowReturnOutsideFunction: true }));
  const selectedValues = new Set(obfuscatedStrings);
  const replacements: SourceEdit[] = [];
  const identifiers = new Set<string>();

  walkJavaScript(ast, null, (node, parent) => {
    if (node.type === "Identifier" && typeof node.name === "string") {
      identifiers.add(node.name);
    }

    const value = getEligibleStringValue(node, parent);
    if (value === undefined || !selectedValues.has(value)) {
      return;
    }

    replacements.push({
      content: "",
      end: node.end,
      literalValue: value,
      mapToStart: node.start,
      start: node.start,
    });
  });

  if (replacements.length === 0) {
    return null;
  }

  const helperName = getUniqueIdentifier("_viteBytecodeFromCharCode", identifiers);
  for (const replacement of replacements) {
    const value = replacement.literalValue;
    if (value === undefined) {
      throw new Error("Unable to recover an obfuscated string literal");
    }
    replacement.content = createObfuscatedExpression(helperName, value);
  }

  const insertionPoint = getHelperInsertionPoint(ast, code);
  replacements.push({
    content:
      `${insertionPoint === 0 ? "" : "\n"}` +
      `const ${helperName} = globalThis.String.fromCharCode.bind(globalThis.String);\n`,
    end: insertionPoint,
    start: insertionPoint,
  });

  const transformed = applySourceEdits(code, replacements);
  return {
    code: transformed.code,
    map: sourceMaps
      ? createSourceMap(sourceFileName, code, transformed.mappingPoints, transformed.code)
      : undefined,
  };
}

/**
 * Rewrites string arguments in real, unshadowed `require()` calls.
 */
export function rewriteRequireSpecifiers(
  code: string,
  replace: (specifier: string) => string | undefined,
  parse: ParseAst,
): { code: string; rewritten: boolean } {
  if (!code.includes("require")) {
    return { code, rewritten: false };
  }

  const ast = asJavaScriptNode(parse(code, { allowReturnOutsideFunction: true }));
  const scopeByNode = createScopes(ast);
  const replacements: SourceEdit[] = [];

  walkJavaScript(ast, null, (node) => {
    if (node.type !== "CallExpression") {
      return;
    }

    const callee = asJavaScriptNodeOrNull(node.callee);
    const args = Array.isArray(node.arguments) ? node.arguments : [];
    const argument = asJavaScriptNodeOrNull(args[0]);
    const scope = scopeByNode.get(node);
    if (
      !callee ||
      callee.type !== "Identifier" ||
      callee.name !== "require" ||
      args.length !== 1 ||
      !argument ||
      argument.type !== "Literal" ||
      typeof argument.value !== "string" ||
      !scope ||
      hasBinding(scope, "require")
    ) {
      return;
    }

    const replacement = replace(argument.value);
    if (replacement === undefined || replacement === argument.value) {
      return;
    }

    replacements.push({
      content: JSON.stringify(replacement),
      end: argument.end,
      start: argument.start,
    });
  });

  if (replacements.length === 0) {
    return { code, rewritten: false };
  }

  return {
    code: applySourceEdits(code, replacements).code,
    rewritten: true,
  };
}

function getEligibleStringValue(
  node: JavaScriptNode,
  parent: ParentNode | null,
): string | undefined {
  if (node.type === "Literal" && typeof node.value === "string") {
    if (!parent || shouldPreserveStringLiteral(node, parent)) {
      return undefined;
    }
    return node.value;
  }

  if (
    node.type !== "TemplateLiteral" ||
    !Array.isArray(node.expressions) ||
    node.expressions.length !== 0 ||
    !Array.isArray(node.quasis) ||
    node.quasis.length !== 1 ||
    (parent?.node.type === "TaggedTemplateExpression" && parent.key === "quasi")
  ) {
    return undefined;
  }

  const quasi = asJavaScriptNodeOrNull(node.quasis[0]);
  const value = quasi?.value;
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const cooked = (value as { cooked?: unknown }).cooked;
  return typeof cooked === "string" ? cooked : undefined;
}

function shouldPreserveStringLiteral(node: JavaScriptNode, parent: ParentNode): boolean {
  const parentNode = parent.node;

  if (
    parentNode.type === "ExpressionStatement" &&
    parent.key === "expression" &&
    typeof parentNode.directive === "string"
  ) {
    return true;
  }

  if (
    parent.key === "key" &&
    parentNode.computed === false &&
    (parentNode.type === "Property" ||
      parentNode.type === "MethodDefinition" ||
      parentNode.type === "PropertyDefinition" ||
      parentNode.type === "AccessorProperty")
  ) {
    return true;
  }

  if (
    parentNode.type === "MemberExpression" &&
    parent.key === "property" &&
    parentNode.computed === true
  ) {
    return true;
  }

  if (
    (parentNode.type === "ImportDeclaration" ||
      parentNode.type === "ImportExpression" ||
      parentNode.type === "ExportAllDeclaration" ||
      parentNode.type === "ExportNamedDeclaration") &&
    parent.key === "source"
  ) {
    return true;
  }

  if (parentNode.type === "CallExpression" && parent.key === "arguments") {
    const callee = asJavaScriptNodeOrNull(parentNode.callee);
    const args = Array.isArray(parentNode.arguments) ? parentNode.arguments : [];
    if (args[0] !== node || !callee) {
      return false;
    }
    if (callee.type === "Identifier" && callee.name === "require") {
      return true;
    }
    if (callee.type === "MemberExpression") {
      const object = asJavaScriptNodeOrNull(callee.object);
      const property = asJavaScriptNodeOrNull(callee.property);
      return (
        object?.type === "Identifier" &&
        object.name === "require" &&
        property?.type === "Identifier" &&
        property.name === "resolve"
      );
    }
  }

  return false;
}

function createObfuscatedExpression(helperName: string, value: string): string {
  const characterCodes: number[] = [];
  for (let index = 0; index < value.length; index++) {
    characterCodes.push(value.charCodeAt(index));
  }

  const calls: string[] = [];
  for (let index = 0; index < characterCodes.length; index += CHAR_CODE_CHUNK_SIZE) {
    calls.push(
      `${helperName}(${characterCodes.slice(index, index + CHAR_CODE_CHUNK_SIZE).join(",")})`,
    );
  }

  if (calls.length === 0) {
    calls.push(`${helperName}()`);
  }

  return `(${calls.join(" + ")})`;
}

function getUniqueIdentifier(base: string, identifiers: Set<string>): string {
  if (!identifiers.has(base)) {
    return base;
  }

  let suffix = 1;
  while (identifiers.has(`${base}$${String(suffix)}`)) {
    suffix++;
  }
  return `${base}$${String(suffix)}`;
}

function getHelperInsertionPoint(ast: JavaScriptNode, code: string): number {
  const hashbangEnd = code.startsWith("#!") ? code.indexOf("\n") : -1;
  let insertionPoint =
    hashbangEnd === -1 ? (code.startsWith("#!") ? code.length : 0) : hashbangEnd + 1;
  const body = Array.isArray(ast.body) ? ast.body : [];

  for (const value of body) {
    const statement = asJavaScriptNodeOrNull(value);
    if (
      !statement ||
      statement.type !== "ExpressionStatement" ||
      typeof statement.directive !== "string"
    ) {
      break;
    }
    insertionPoint = statement.end;
  }

  return insertionPoint;
}

function applySourceEdits(
  code: string,
  edits: SourceEdit[],
): { code: string; mappingPoints: MappingPoint[] } {
  const orderedEdits = [...edits].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const lineStarts = getLineStarts(code);
  const mappingPoints: MappingPoint[] = [];
  let cursor = 0;
  let generatedCode = "";
  let generatedLine = 0;
  let generatedColumn = 0;

  const append = (content: string): void => {
    generatedCode += content;
    const lines = content.split("\n");
    if (lines.length === 1) {
      generatedColumn += content.length;
    } else {
      generatedLine += lines.length - 1;
      generatedColumn = lines.at(-1)?.length ?? 0;
    }
  };

  const appendOriginal = (start: number, end: number): void => {
    if (start >= end) {
      return;
    }

    let sourceOffset = start;
    let segmentStart = start;
    while (segmentStart < end) {
      const newline = code.indexOf("\n", segmentStart);
      const segmentEnd = newline === -1 || newline >= end ? end : newline + 1;
      const original = getLineAndColumn(lineStarts, sourceOffset);
      mappingPoints.push({
        generatedColumn,
        generatedLine,
        originalColumn: original.column,
        originalLine: original.line,
      });
      append(code.slice(segmentStart, segmentEnd));
      sourceOffset = segmentEnd;
      segmentStart = segmentEnd;
    }
  };

  for (const edit of orderedEdits) {
    if (edit.start < cursor || edit.end < edit.start || edit.end > code.length) {
      throw new Error("Overlapping or invalid JavaScript source edits");
    }

    appendOriginal(cursor, edit.start);
    if (edit.mapToStart !== undefined) {
      const original = getLineAndColumn(lineStarts, edit.mapToStart);
      mappingPoints.push({
        generatedColumn,
        generatedLine,
        originalColumn: original.column,
        originalLine: original.line,
      });
    }
    append(edit.content);
    cursor = edit.end;
  }

  appendOriginal(cursor, code.length);
  return { code: generatedCode, mappingPoints };
}

function createSourceMap(
  sourceFileName: string,
  source: string,
  mappingPoints: MappingPoint[],
  generatedCode: string,
): SourceMapInput {
  const generatedLineCount = generatedCode.split("\n").length;
  const pointsByLine = new Map<number, MappingPoint[]>();
  for (const point of mappingPoints) {
    const points = pointsByLine.get(point.generatedLine) ?? [];
    points.push(point);
    pointsByLine.set(point.generatedLine, points);
  }

  let previousSource = 0;
  let previousOriginalLine = 0;
  let previousOriginalColumn = 0;
  const mappingLines: string[] = [];

  for (let line = 0; line < generatedLineCount; line++) {
    const points = (pointsByLine.get(line) ?? []).sort(
      (left, right) => left.generatedColumn - right.generatedColumn,
    );
    let previousGeneratedColumn = 0;
    let previousPointColumn = -1;
    const segments: string[] = [];

    for (const point of points) {
      if (point.generatedColumn === previousPointColumn) {
        continue;
      }
      const segment = [
        point.generatedColumn - previousGeneratedColumn,
        -previousSource,
        point.originalLine - previousOriginalLine,
        point.originalColumn - previousOriginalColumn,
      ];
      segments.push(segment.map(encodeVlq).join(""));
      previousGeneratedColumn = point.generatedColumn;
      previousSource = 0;
      previousOriginalLine = point.originalLine;
      previousOriginalColumn = point.originalColumn;
      previousPointColumn = point.generatedColumn;
    }

    mappingLines.push(segments.join(","));
  }

  return {
    mappings: mappingLines.join(";"),
    names: [],
    sources: [sourceFileName],
    sourcesContent: [source],
    version: 3,
  };
}

function encodeVlq(value: number): string {
  let encoded = "";
  let vlq = value < 0 ? (-value << 1) | 1 : value << 1;

  do {
    let digit = vlq & 31;
    vlq >>>= 5;
    if (vlq > 0) {
      digit |= 32;
    }
    encoded += BASE64_CHARACTERS[digit];
  } while (vlq > 0);

  return encoded;
}

function getLineStarts(code: string): number[] {
  const lineStarts = [0];
  for (let index = 0; index < code.length; index++) {
    if (code[index] === "\n") {
      lineStarts.push(index + 1);
    }
  }
  return lineStarts;
}

function getLineAndColumn(lineStarts: number[], offset: number): { column: number; line: number } {
  let low = 0;
  let high = lineStarts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= offset) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return { column: offset - lineStarts[low], line: low };
}

function createScopes(ast: JavaScriptNode): WeakMap<JavaScriptNode, Scope> {
  const scopeByNode = new WeakMap<JavaScriptNode, Scope>();

  const visit = (node: JavaScriptNode, incomingScope: Scope | null): void => {
    let scope = incomingScope;

    if (node.type === "Program") {
      scope = createScope(null, true);
    } else {
      if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && scope) {
        addPatternBindings(node.id, scope.bindings);
      }

      if (isFunctionNode(node)) {
        scope = createScope(scope, true);
        if (node.type === "FunctionExpression") {
          addPatternBindings(node.id, scope.bindings);
        }
        if (Array.isArray(node.params)) {
          for (const parameter of node.params) {
            addPatternBindings(parameter, scope.bindings);
          }
        }
      } else if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
        scope = createScope(scope, false);
        addPatternBindings(node.id, scope.bindings);
      } else if (
        node.type === "BlockStatement" ||
        node.type === "CatchClause" ||
        node.type === "ForStatement" ||
        node.type === "ForInStatement" ||
        node.type === "ForOfStatement" ||
        node.type === "StaticBlock" ||
        node.type === "SwitchStatement"
      ) {
        scope = createScope(scope, false);
        if (node.type === "CatchClause") {
          addPatternBindings(node.param, scope.bindings);
        }
      }
    }

    if (!scope) {
      throw new Error("JavaScript AST does not contain a Program scope");
    }
    scopeByNode.set(node, scope);

    if (node.type === "VariableDeclaration") {
      const declarationScope = node.kind === "var" ? getFunctionScope(scope) : scope;
      if (Array.isArray(node.declarations)) {
        for (const value of node.declarations) {
          const declaration = asJavaScriptNodeOrNull(value);
          addPatternBindings(declaration?.id, declarationScope.bindings);
        }
      }
    } else if (node.type === "ImportDeclaration") {
      if (Array.isArray(node.specifiers)) {
        for (const value of node.specifiers) {
          const specifier = asJavaScriptNodeOrNull(value);
          addPatternBindings(specifier?.local, scope.bindings);
        }
      }
    }

    forEachChildNode(node, (child) => visit(child, scope));
  };

  visit(ast, null);
  return scopeByNode;
}

function createScope(parent: Scope | null, functionScope: boolean): Scope {
  return { bindings: new Set(), functionScope, parent };
}

function getFunctionScope(scope: Scope): Scope {
  let current = scope;
  while (!current.functionScope && current.parent) {
    current = current.parent;
  }
  return current;
}

function hasBinding(scope: Scope, name: string): boolean {
  let current: Scope | null = scope;
  while (current) {
    if (current.bindings.has(name)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isFunctionNode(node: JavaScriptNode): boolean {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function addPatternBindings(value: unknown, bindings: Set<string>): void {
  const node = asJavaScriptNodeOrNull(value);
  if (!node) {
    return;
  }

  if (node.type === "Identifier" && typeof node.name === "string") {
    bindings.add(node.name);
    return;
  }

  if (node.type === "RestElement") {
    addPatternBindings(node.argument, bindings);
  } else if (node.type === "AssignmentPattern") {
    addPatternBindings(node.left, bindings);
  } else if (node.type === "ArrayPattern" && Array.isArray(node.elements)) {
    for (const element of node.elements) {
      addPatternBindings(element, bindings);
    }
  } else if (node.type === "ObjectPattern" && Array.isArray(node.properties)) {
    for (const value of node.properties) {
      const property = asJavaScriptNodeOrNull(value);
      if (property?.type === "RestElement") {
        addPatternBindings(property.argument, bindings);
      } else {
        addPatternBindings(property?.value, bindings);
      }
    }
  }
}

function walkJavaScript(
  node: JavaScriptNode,
  parent: ParentNode | null,
  visit: (node: JavaScriptNode, parent: ParentNode | null) => void,
): void {
  visit(node, parent);
  forEachChildNode(node, (child, key) => {
    walkJavaScript(child, { key, node }, visit);
  });
}

function forEachChildNode(
  node: JavaScriptNode,
  visit: (node: JavaScriptNode, key: string) => void,
): void {
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "type") {
      continue;
    }

    const child = asJavaScriptNodeOrNull(value);
    if (child) {
      visit(child, key);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        const arrayChild = asJavaScriptNodeOrNull(item);
        if (arrayChild) {
          visit(arrayChild, key);
        }
      }
    }
  }
}

function asJavaScriptNode(value: unknown): JavaScriptNode {
  const node = asJavaScriptNodeOrNull(value);
  if (!node) {
    throw new Error("Expected a JavaScript AST node");
  }
  return node;
}

function asJavaScriptNodeOrNull(value: unknown): JavaScriptNode | null {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as { type?: unknown }).type !== "string" ||
    typeof (value as { start?: unknown }).start !== "number" ||
    typeof (value as { end?: unknown }).end !== "number"
  ) {
    return null;
  }
  return value as JavaScriptNode;
}
