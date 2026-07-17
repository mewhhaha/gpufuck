import {
  type EncodedFunctionalModule,
  FUNCTIONAL_CONSTRUCTOR_WORD_LENGTH,
  FUNCTIONAL_DEFINITION_WORD_LENGTH,
  FUNCTIONAL_NO_INDEX,
  FUNCTIONAL_NODE_WORD_LENGTH,
  FUNCTIONAL_TYPE_WORD_LENGTH,
  FunctionalAlgebraicTypeWord,
  FunctionalBinaryOperator,
  FunctionalConstructorWord,
  FunctionalCoreTag,
  FunctionalDefinitionWord,
  FunctionalExpressionTag,
  FunctionalNodeWord,
  type FunctionalType,
  type FunctionalTypeSchema,
} from "./abi.ts";
import type { FunctionalCoreNode, GpuFunctionalModule } from "./compiler.ts";
import type { FunctionalEvaluationResult } from "./evaluator.ts";
import type {
  FunctionalSurfaceDefinition,
  FunctionalSurfaceExpression,
  FunctionalSurfaceTypeDeclaration,
} from "./surface_builder.ts";

export interface FunctionalCompilationTraceSurface {
  readonly definitions: readonly FunctionalSurfaceDefinition[];
  readonly typeDeclarations: readonly FunctionalSurfaceTypeDeclaration[];
  readonly module: EncodedFunctionalModule;
}

export interface FunctionalCompilationTraceInput {
  readonly title: string;
  readonly sourceLabel: string;
  readonly introduction: string;
  readonly source: string;
  readonly surface: FunctionalCompilationTraceSurface;
  readonly compiledModule: GpuFunctionalModule;
  readonly coreNodes: readonly FunctionalCoreNode[];
  readonly evaluation: FunctionalEvaluationResult;
}

export function renderFunctionalCompilationTrace(input: FunctionalCompilationTraceInput): string {
  const normalized = formatNormalizedSurface(
    input.surface.definitions,
    input.surface.typeDeclarations,
  );
  const encoded = formatEncodedModule(input.surface.module);
  const core = formatCoreModule(input.compiledModule, input.surface.module, input.coreNodes);
  const outcome = input.evaluation.ok
    ? JSON.stringify(
      {
        entryType: input.compiledModule.entryType,
        value: input.evaluation.value,
        stats: input.evaluation.stats,
      },
      null,
      2,
    )
    : JSON.stringify(
      { entryType: input.compiledModule.entryType, fault: input.evaluation.fault },
      null,
      2,
    );

  return `# ${input.title}

${input.introduction}

<table>
<tr><th>${escapeHtml(input.sourceLabel)}</th><th>Normalized functional surface</th></tr>
<tr><td><pre><code>${escapeHtml(input.source.trimEnd())}</code></pre></td><td><pre><code>${
    escapeHtml(normalized)
  }</code></pre></td></tr>
<tr><th>Encoded functional ABI</th><th>GPU-resolved core IR</th></tr>
<tr><td><pre><code>${escapeHtml(encoded)}</code></pre></td><td><pre><code>${
    escapeHtml(core)
  }</code></pre></td></tr>
</table>

## Evaluation

\`\`\`json
${outcome}
\`\`\`
`;
}

function formatNormalizedSurface(
  definitions: readonly FunctionalSurfaceDefinition[],
  typeDeclarations: readonly FunctionalSurfaceTypeDeclaration[],
): string {
  const declarations = typeDeclarations.map(formatSurfaceTypeDeclaration);
  const functions = definitions.map((definition) =>
    `fn ${definition.name}(${definition.parameters.join(", ")}) : ${
      definition.annotation === null ? "<inferred>" : formatType(definition.annotation)
    } =\n${formatExpression(definition.body, 1)}`
  );
  return [...declarations, ...functions].join("\n\n");
}

function formatSurfaceTypeDeclaration(declaration: FunctionalSurfaceTypeDeclaration): string {
  const parameters = declaration.parameters.length === 0
    ? ""
    : `<${declaration.parameters.join(", ")}>`;
  const constructors = declaration.constructors.map((constructor) => {
    const fields = constructor.fields.length === 0
      ? ""
      : `(${
        constructor.fields.map((field) => `${field.name}: ${formatType(field.type)}`).join(", ")
      })`;
    const result = constructor.result === undefined ? "" : ` : ${formatType(constructor.result)}`;
    return `  | ${constructor.name}${fields}${result}`;
  });
  return `type ${declaration.name}${parameters} =\n${constructors.join("\n")}`;
}

function formatExpression(expression: FunctionalSurfaceExpression, depth: number): string {
  const indent = "  ".repeat(depth);
  const nested = (value: FunctionalSurfaceExpression): string => formatExpression(value, depth + 1);
  switch (expression.kind) {
    case "integer":
      return `${indent}${expression.value}`;
    case "boolean":
      return `${indent}${expression.value}`;
    case "name":
      return `${indent}${expression.name}`;
    case "lambda":
      return `${indent}(lambda ${expression.parameter}\n${nested(expression.body)})`;
    case "let":
      return `${indent}(let ${expression.name}\n${nested(expression.value)}\n${
        nested(expression.body)
      })`;
    case "let-rec":
      return `${indent}(let-rec ${expression.name}\n${nested(expression.value)}\n${
        nested(expression.body)
      })`;
    case "if":
      return `${indent}(if\n${nested(expression.condition)}\n${nested(expression.consequent)}\n${
        nested(expression.alternate)
      })`;
    case "apply":
      return `${indent}(apply\n${nested(expression.callee)}\n${nested(expression.argument)})`;
    case "binary":
      return `${indent}(${binaryOperatorName(expression.operator)}\n${nested(expression.left)}\n${
        nested(expression.right)
      })`;
    case "case": {
      const arms = expression.arms.map((arm) =>
        `${"  ".repeat(depth + 1)}(${arm.constructor} ${arm.binders.join(" ")} ->\n${
          formatExpression(arm.body, depth + 2)
        })`
      );
      return `${indent}(case\n${nested(expression.value)}\n${arms.join("\n")})`;
    }
  }
}

function formatEncodedModule(module: EncodedFunctionalModule): string {
  const lines = [
    `ABI v${module.abiVersion}; entry=${symbol(module, module.entrySymbol)}`,
    "",
    "definitions:",
  ];
  for (let index = 0; index < module.definitionCount; index++) {
    const base = index * FUNCTIONAL_DEFINITION_WORD_LENGTH;
    const name = requiredWord(
      module.definitionWords,
      base + FunctionalDefinitionWord.Symbol,
      "definition symbol",
    );
    const root = requiredWord(
      module.definitionWords,
      base + FunctionalDefinitionWord.RootNode,
      "definition root",
    );
    const start = requiredWord(
      module.definitionWords,
      base + FunctionalDefinitionWord.StartByte,
      "definition start",
    );
    const end = requiredWord(
      module.definitionWords,
      base + FunctionalDefinitionWord.EndByte,
      "definition end",
    );
    lines.push(
      `  d${index} ${symbol(module, name)} root=n${root} bytes=${start}..${end} : ${
        formatDefinitionType(module, index)
      }`,
    );
  }
  lines.push("", "types:");
  for (let index = 0; index < module.typeCount; index++) {
    const base = index * FUNCTIONAL_TYPE_WORD_LENGTH;
    const name = requiredWord(
      module.typeWords,
      base + FunctionalAlgebraicTypeWord.Symbol,
      "type symbol",
    );
    const first = requiredWord(
      module.typeWords,
      base + FunctionalAlgebraicTypeWord.FirstConstructor,
      "first constructor",
    );
    const count = requiredWord(
      module.typeWords,
      base + FunctionalAlgebraicTypeWord.ConstructorCount,
      "constructor count",
    );
    lines.push(`  t${index} ${symbol(module, name)} constructors=[c${first},c${first + count})`);
  }
  lines.push("", "constructors:");
  for (let index = 0; index < module.constructorCount; index++) {
    const base = index * FUNCTIONAL_CONSTRUCTOR_WORD_LENGTH;
    const name = requiredWord(
      module.constructorWords,
      base + FunctionalConstructorWord.Symbol,
      "constructor symbol",
    );
    const type = requiredWord(
      module.constructorWords,
      base + FunctionalConstructorWord.Type,
      "constructor type",
    );
    const arity = requiredWord(
      module.constructorWords,
      base + FunctionalConstructorWord.Arity,
      "constructor arity",
    );
    lines.push(`  c${index} ${symbol(module, name)} owner=t${type} arity=${arity}`);
  }
  lines.push("", "nodes:");
  for (let index = 0; index < module.nodeCount; index++) {
    const base = index * FUNCTIONAL_NODE_WORD_LENGTH;
    const tag = requiredWord(module.nodeWords, base + FunctionalNodeWord.Tag, "node tag");
    const payload = requiredWord(
      module.nodeWords,
      base + FunctionalNodeWord.Payload,
      "node payload",
    );
    const children = [
      requiredWord(module.nodeWords, base + FunctionalNodeWord.Child0, "node child 0"),
      requiredWord(module.nodeWords, base + FunctionalNodeWord.Child1, "node child 1"),
      requiredWord(module.nodeWords, base + FunctionalNodeWord.Child2, "node child 2"),
    ];
    const parent = requiredWord(module.nodeWords, base + FunctionalNodeWord.Parent, "node parent");
    const start = requiredWord(module.nodeWords, base + FunctionalNodeWord.StartByte, "node start");
    const end = requiredWord(module.nodeWords, base + FunctionalNodeWord.EndByte, "node end");
    lines.push(
      `  n${index} ${surfaceTagName(tag)} ${surfacePayload(module, tag, payload)} ` +
        `children=${formatEdges(children, "n")} parent=${
          formatEdge(parent, "n")
        } bytes=${start}..${end}`,
    );
  }
  return lines.join("\n");
}

function formatDefinitionType(module: EncodedFunctionalModule, index: number): string {
  const definitionType = module.definitionTypes[index];
  if (definitionType === undefined) {
    throw new Error(`Functional trace omitted definition type ${index}.`);
  }
  return definitionType.annotation === null ? "<inferred>" : formatType(definitionType.annotation);
}

function formatCoreModule(
  module: GpuFunctionalModule,
  encoded: EncodedFunctionalModule,
  nodes: readonly FunctionalCoreNode[],
): string {
  const lines = [
    `entry=d${module.entryDefinition}; type=${formatType(module.entryType)}; effects=${
      JSON.stringify(module.entryEffects)
    }`,
    "",
    "nodes:",
  ];
  for (const [index, node] of nodes.entries()) {
    lines.push(
      `  n${index} ${coreTagName(node.tag)} ${corePayload(module, encoded, node)} ` +
        `children=${formatEdges([node.child0, node.child1, node.child2], "n")} ` +
        `sourceByte=${node.sourceByteOffset}`,
    );
  }
  return lines.join("\n");
}

function surfacePayload(module: EncodedFunctionalModule, tag: number, payload: number): string {
  switch (tag) {
    case FunctionalExpressionTag.Integer:
      return `value=${payload | 0}`;
    case FunctionalExpressionTag.Boolean:
      return `value=${payload === 0 ? "false" : "true"}`;
    case FunctionalExpressionTag.Name:
    case FunctionalExpressionTag.Let:
    case FunctionalExpressionTag.StrictLet:
    case FunctionalExpressionTag.LetRec:
    case FunctionalExpressionTag.Lambda:
    case FunctionalExpressionTag.CaseArm:
    case FunctionalExpressionTag.PatternBind:
      return `symbol=${symbol(module, payload)}`;
    case FunctionalExpressionTag.Binary:
      return `operator=${binaryOperatorName(payload)}`;
    case FunctionalExpressionTag.StrictApply:
      return "evaluation=strict";
    default:
      return "";
  }
}

function corePayload(
  module: GpuFunctionalModule,
  encoded: EncodedFunctionalModule,
  node: FunctionalCoreNode,
): string {
  switch (node.tag) {
    case FunctionalCoreTag.Integer:
      return `value=${node.payload | 0}`;
    case FunctionalCoreTag.Boolean:
      return `value=${node.payload === 0 ? "false" : "true"}`;
    case FunctionalCoreTag.Local:
      return `depth=${node.payload}`;
    case FunctionalCoreTag.Global:
      return `definition=d${node.payload}`;
    case FunctionalCoreTag.Constructor:
      return `constructor=c${node.payload}:${module.constructorNames[node.payload] ?? "?"}`;
    case FunctionalCoreTag.Lambda:
    case FunctionalCoreTag.LetRec:
    case FunctionalCoreTag.PatternBind:
      return `symbol=${symbol(encoded, node.payload)}`;
    case FunctionalCoreTag.Let:
      return `symbol=${symbol(encoded, node.payload)} evaluation=${
        evaluationName(node.evaluationMode)
      }`;
    case FunctionalCoreTag.CaseArm:
      return `constructor=c${node.payload}:${module.constructorNames[node.payload] ?? "?"}`;
    case FunctionalCoreTag.Binary:
      return `operator=${binaryOperatorName(node.payload)}`;
    case FunctionalCoreTag.Apply:
      return `evaluation=${evaluationName(node.evaluationMode)}`;
    default:
      return node.payload === 0 ? "" : `payload=${node.payload}`;
  }
}

function evaluationName(mode: number): string {
  return mode === 0 ? "lazy" : "strict";
}

function surfaceTagName(tag: number): string {
  for (const [name, value] of Object.entries(FunctionalExpressionTag)) {
    if (value === tag) return name;
  }
  return `Tag${tag}`;
}

function coreTagName(tag: number): string {
  for (const [name, value] of Object.entries(FunctionalCoreTag)) {
    if (value === tag) return name;
  }
  return `Tag${tag}`;
}

function binaryOperatorName(operator: number): string {
  for (const [name, value] of Object.entries(FunctionalBinaryOperator)) {
    if (value === operator) return name;
  }
  return `operator${operator}`;
}

function formatType(type: FunctionalTypeSchema | FunctionalType): string {
  switch (type.kind) {
    case "integer":
      return "i32";
    case "boolean":
      return "bool";
    case "unit":
      return "()";
    case "parameter":
      return type.name;
    case "tuple":
      return `(${formatType(type.values[0])}, ${formatType(type.values[1])})`;
    case "named": {
      const arguments_ = type.arguments.length === 0
        ? ""
        : `<${type.arguments.map(formatType).join(", ")}>`;
      return `${type.name}${arguments_}`;
    }
    case "function":
      return `${
        type.parameter.kind === "function" || type.parameter.kind === "forall"
          ? `(${formatType(type.parameter)})`
          : formatType(type.parameter)
      } -> ${formatType(type.result)}`;
    case "forall":
      return `forall ${type.parameters.join(" ")}. ${formatType(type.body)}`;
  }
}

function formatEdges(edges: readonly number[], prefix: string): string {
  const present = edges.filter((edge) => edge !== FUNCTIONAL_NO_INDEX);
  return `[${present.map((edge) => `${prefix}${edge}`).join(",")}]`;
}

function formatEdge(edge: number, prefix: string): string {
  return edge === FUNCTIONAL_NO_INDEX ? "-" : `${prefix}${edge}`;
}

function symbol(module: EncodedFunctionalModule, id: number): string {
  return module.symbolNames[id] ?? `<symbol ${id}>`;
}

function requiredWord(words: Uint32Array, offset: number, location: string): number {
  const word = words[offset];
  if (word === undefined) {
    throw new Error(`Functional trace omitted ${location} at word ${offset}.`);
  }
  return word;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
