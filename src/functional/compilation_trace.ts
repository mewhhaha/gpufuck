import {
  AlgebraicTypeWord,
  BinaryOperator,
  CONSTRUCTOR_WORD_LENGTH,
  ConstructorWord,
  CoreTag,
  DEFINITION_WORD_LENGTH,
  DefinitionWord,
  type EncodedModule,
  ExpressionTag,
  NO_INDEX,
  NODE_WORD_LENGTH,
  NodeWord,
  type Type,
  TYPE_WORD_LENGTH,
  type TypeSchema,
  UnaryOperator,
} from "./abi.ts";
import { effectNames } from "./effect_set.ts";
import type { CoreNode, GpuModule } from "./compiler.ts";
import type { WasmExecution } from "./wasm_execution.ts";
import { primopDeclaration } from "../semantic/primops.ts";
import type {
  SurfaceDefinition,
  SurfaceExpression,
  SurfaceTypeDeclaration,
} from "./surface_builder.ts";

export interface CompilationTraceSurface {
  readonly definitions: readonly SurfaceDefinition[];
  readonly typeDeclarations: readonly SurfaceTypeDeclaration[];
  readonly module: EncodedModule;
}

export interface CompilationTraceInput {
  readonly title: string;
  readonly sourceLabel: string;
  readonly introduction: string;
  readonly source: string;
  readonly surface: CompilationTraceSurface;
  readonly compiledModule: GpuModule;
  readonly coreNodes: readonly CoreNode[];
  readonly evaluation: WasmExecution;
}

/** `JSON.stringify` escapes control characters, so the marker has to survive as printable text. */
const BIGINT_MARKER = "@@functional-bigint@@";

/**
 * 64-bit values arrive as BigInt, which `JSON.stringify` refuses outright. Quoting them would change
 * the shape of every checked-in trace, and routing them through `Number` would lose precision past
 * 2^53, so the exact digits are marked during serialization and unquoted afterwards.
 */
function formatOutcome(outcome: unknown): string {
  const marked = JSON.stringify(
    outcome,
    (_key, value) => typeof value === "bigint" ? `${BIGINT_MARKER}${value}` : value,
    2,
  );
  return marked.replaceAll(new RegExp(`"${BIGINT_MARKER}(-?\\d+)"`, "g"), "$1");
}

export function renderCompilationTrace(input: CompilationTraceInput): string {
  const normalized = formatNormalizedSurface(
    input.surface.definitions,
    input.surface.typeDeclarations,
  );
  const encoded = formatEncodedModule(input.surface.module);
  const core = formatCoreModule(input.compiledModule, input.surface.module, input.coreNodes);
  const outcome = formatOutcome({
    entryType: input.compiledModule.entryType,
    value: input.evaluation.value,
    stats: input.evaluation.stats,
  });

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
  definitions: readonly SurfaceDefinition[],
  typeDeclarations: readonly SurfaceTypeDeclaration[],
): string {
  const declarations = typeDeclarations.map(formatSurfaceTypeDeclaration);
  const functions = definitions.map((definition) => {
    const effects = definition.effects === undefined || definition.effects.size === 0
      ? ""
      : ` !${JSON.stringify(effectNames(definition.effects))}`;
    return `fn ${definition.name}(${definition.parameters.join(", ")}) : ${
      definition.annotation === null ? "<inferred>" : formatType(definition.annotation)
    }${effects} =\n${formatExpression(definition.body, 1)}`;
  });
  return [...declarations, ...functions].join("\n\n");
}

function formatSurfaceTypeDeclaration(declaration: SurfaceTypeDeclaration): string {
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

function formatExpression(expression: SurfaceExpression, depth: number): string {
  const indent = "  ".repeat(depth);
  const nested = (value: SurfaceExpression): string => formatExpression(value, depth + 1);
  switch (expression.kind) {
    case "integer":
      return `${indent}${expression.value}`;
    case "signed-integer-64":
      return `${indent}${expression.value}i64`;
    case "float-32":
      return `${indent}${expression.value}f32`;
    case "float-64":
      return `${indent}${expression.value}f64`;
    case "whole-number-f64":
      return `${indent}${expression.value}whole-f64`;
    case "boolean":
      return `${indent}${expression.value}`;
    case "text":
      return `${indent}${JSON.stringify(expression.value)}`;
    case "bytes":
      return `${indent}bytes[${[...expression.value].join(", ")}]`;
    case "runtime-fault":
      return `${indent}fault ${JSON.stringify(expression.message)}`;
    case "name":
      return `${indent}${expression.name}`;
    case "lambda":
      return `${indent}(lambda (${expression.parameters.join(" ")})\n${nested(expression.body)})`;
    case "let":
      return `${indent}(let ${expression.name}\n${nested(expression.value)}\n${
        nested(expression.body)
      })`;
    case "sequence":
      return `${indent}(sequence ${expression.name}\n${nested(expression.value)}\n${
        nested(expression.body)
      })`;
    case "let-rec":
      return `${indent}(let-rec ${expression.name}\n${nested(expression.value)}\n${
        nested(expression.body)
      })`;
    case "let-rec-group": {
      const bindings = expression.bindings.map((binding) =>
        `${"  ".repeat(depth + 1)}(${binding.name} ${binding.parameters.join(" ")} =\n${
          formatExpression(binding.body, depth + 2)
        })`
      );
      return `${indent}(let-rec-group\n${bindings.join("\n")}\n${nested(expression.body)})`;
    }
    case "if":
      return `${indent}(if\n${nested(expression.condition)}\n${nested(expression.consequent)}\n${
        nested(expression.alternate)
      })`;
    case "apply": {
      const arguments_ = expression.arguments.map((argument) =>
        formatExpression(argument, depth + 1)
      );
      return `${indent}(apply\n${nested(expression.callee)}${
        arguments_.length === 0 ? "" : `\n${arguments_.join("\n")}`
      })`;
    }
    case "unary":
      return `${indent}(${unaryOperatorName(expression.operator)}\n${nested(expression.value)})`;
    case "binary":
      return `${indent}(${binaryOperatorName(expression.operator)}\n${nested(expression.left)}\n${
        nested(expression.right)
      })`;
    case "text-append":
    case "bytes-append":
      return `${indent}(${expression.kind}\n${nested(expression.left)}\n${
        nested(expression.right)
      })`;
    case "store-new":
      return `${indent}(store-new\n${nested(expression.length)}\n${nested(expression.initial)})`;
    case "store-empty":
      return `${indent}(store-empty)`;
    case "store-length":
      return `${indent}(store-length\n${nested(expression.store)})`;
    case "store-read":
      return `${indent}(store-read\n${nested(expression.store)}\n${nested(expression.index)})`;
    case "store-write":
      return `${indent}(store-write\n${
        nested(expression.store)
      }\n${nested(expression.index)}\n${nested(expression.value)})`;
    case "store-grow":
      return `${indent}(store-grow\n${
        nested(expression.store)
      }\n${nested(expression.length)}\n${nested(expression.initial)})`;
    case "numeric-convert":
      return `${indent}(convert${expression.conversion}\n${nested(expression.value)})`;
    case "case": {
      const arms = expression.arms.map((arm) =>
        `${"  ".repeat(depth + 1)}(${arm.constructor} ${arm.binders.join(" ")} ->\n${
          formatExpression(arm.body, depth + 2)
        })`
      );
      const otherwise = expression.otherwise === undefined ? [] : [
        `${"  ".repeat(depth + 1)}(_ ${expression.otherwise.binder ?? ""} ->\n${
          formatExpression(expression.otherwise.body, depth + 2)
        })`,
      ];
      return `${indent}(case\n${nested(expression.value)}\n${[...arms, ...otherwise].join("\n")})`;
    }
  }
}

function formatEncodedModule(module: EncodedModule): string {
  const lines = [
    `ABI v${module.abiVersion}; entry=${symbol(module, module.entrySymbol)}`,
    "",
    "definitions:",
  ];
  for (let index = 0; index < module.definitionCount; index++) {
    const base = index * DEFINITION_WORD_LENGTH;
    const name = requiredWord(
      module.definitionWords,
      base + DefinitionWord.Symbol,
      "definition symbol",
    );
    const root = requiredWord(
      module.definitionWords,
      base + DefinitionWord.RootNode,
      "definition root",
    );
    const start = requiredWord(
      module.definitionWords,
      base + DefinitionWord.StartByte,
      "definition start",
    );
    const end = requiredWord(
      module.definitionWords,
      base + DefinitionWord.EndByte,
      "definition end",
    );
    lines.push(
      `  d${index} ${symbol(module, name)} root=n${root} bytes=${start}..${end} : ${
        formatDefinitionType(module, index)
      } effects=${
        JSON.stringify(
          effectNames(module.declaredDefinitionEffects[index]!),
        )
      }`,
    );
  }
  lines.push("", "types:");
  for (let index = 0; index < module.typeCount; index++) {
    const base = index * TYPE_WORD_LENGTH;
    const name = requiredWord(
      module.typeWords,
      base + AlgebraicTypeWord.Symbol,
      "type symbol",
    );
    const first = requiredWord(
      module.typeWords,
      base + AlgebraicTypeWord.FirstConstructor,
      "first constructor",
    );
    const count = requiredWord(
      module.typeWords,
      base + AlgebraicTypeWord.ConstructorCount,
      "constructor count",
    );
    lines.push(`  t${index} ${symbol(module, name)} constructors=[c${first},c${first + count})`);
  }
  lines.push("", "constructors:");
  for (let index = 0; index < module.constructorCount; index++) {
    const base = index * CONSTRUCTOR_WORD_LENGTH;
    const name = requiredWord(
      module.constructorWords,
      base + ConstructorWord.Symbol,
      "constructor symbol",
    );
    const type = requiredWord(
      module.constructorWords,
      base + ConstructorWord.Type,
      "constructor type",
    );
    const arity = requiredWord(
      module.constructorWords,
      base + ConstructorWord.Arity,
      "constructor arity",
    );
    lines.push(`  c${index} ${symbol(module, name)} owner=t${type} arity=${arity}`);
  }
  lines.push("", "nodes:");
  for (let index = 0; index < module.nodeCount; index++) {
    const base = index * NODE_WORD_LENGTH;
    const tag = requiredWord(module.nodeWords, base + NodeWord.Tag, "node tag");
    const payload = requiredWord(
      module.nodeWords,
      base + NodeWord.Payload,
      "node payload",
    );
    const children = [
      requiredWord(module.nodeWords, base + NodeWord.Child0, "node child 0"),
      requiredWord(module.nodeWords, base + NodeWord.Child1, "node child 1"),
      requiredWord(module.nodeWords, base + NodeWord.Child2, "node child 2"),
    ];
    const parent = requiredWord(module.nodeWords, base + NodeWord.Parent, "node parent");
    const start = requiredWord(module.nodeWords, base + NodeWord.StartByte, "node start");
    const end = requiredWord(module.nodeWords, base + NodeWord.EndByte, "node end");
    lines.push(
      `  n${index} ${surfaceTagName(tag)} ${surfacePayload(module, tag, payload)} ` +
        `children=${formatEdges(children, "n")} parent=${
          formatEdge(parent, "n")
        } bytes=${start}..${end}`,
    );
  }
  return lines.join("\n");
}

function formatDefinitionType(module: EncodedModule, index: number): string {
  const definitionType = module.definitionTypes[index];
  if (definitionType === undefined) {
    throw new Error(`Functional trace omitted definition type ${index}.`);
  }
  return definitionType.annotation === null ? "<inferred>" : formatType(definitionType.annotation);
}

function formatCoreModule(
  module: GpuModule,
  encoded: EncodedModule,
  nodes: readonly CoreNode[],
): string {
  const lines = [
    `entry=d${module.entryDefinition}; type=${formatType(module.entryType)}; effects=${
      JSON.stringify(effectNames(module.entryEffects))
    }`,
    "",
    "nodes:",
  ];
  for (const [index, node] of nodes.entries()) {
    lines.push(
      `  n${index} ${coreTagName(node.tag)} ${corePayload(module, encoded, node)} ` +
        `children=${formatEdges(coreChildren(node), "n")} ` +
        `sourceByte=${node.sourceByteOffset}`,
    );
  }
  return lines.join("\n");
}

function surfacePayload(module: EncodedModule, tag: number, payload: number): string {
  switch (tag) {
    case ExpressionTag.Integer:
      return `value=${payload | 0}`;
    case ExpressionTag.Boolean:
      return `value=${payload === 0 ? "false" : "true"}`;
    case ExpressionTag.Name:
    case ExpressionTag.Let:
    case ExpressionTag.Sequence:
    case ExpressionTag.LetRec:
    case ExpressionTag.CaseArm:
    case ExpressionTag.PatternBind:
      return `symbol=${symbol(module, payload)}`;
    case ExpressionTag.Binary:
      return `operator=${binaryOperatorName(payload)}`;
    default:
      return "";
  }
}

function corePayload(
  module: GpuModule,
  encoded: EncodedModule,
  node: CoreNode,
): string {
  switch (node.tag) {
    case CoreTag.Integer:
      return `value=${node.payload | 0}`;
    case CoreTag.Boolean:
      return `value=${node.payload === 0 ? "false" : "true"}`;
    case CoreTag.Local:
      return `depth=${node.payload}`;
    case CoreTag.Global:
      return `definition=d${node.payload}`;
    case CoreTag.Constructor:
      return `constructor=c${node.payload}:${module.constructorNames[node.payload] ?? "?"}`;
    case CoreTag.Lambda:
      return `parameters=p${node.payload}..p${node.payload + node.child1}`;
    case CoreTag.LetRec:
    case CoreTag.PatternBind:
      return `symbol=${symbol(encoded, node.payload)}`;
    case CoreTag.Let:
      return `symbol=${symbol(encoded, node.payload)} evaluation=${
        evaluationName(node.evaluationMode)
      }`;
    case CoreTag.CaseArm:
      return `constructor=c${node.payload}:${module.constructorNames[node.payload] ?? "?"}`;
    case CoreTag.Binary:
      return `operator=${binaryOperatorName(node.payload)}`;
    case CoreTag.Apply:
      return `arguments=a${node.payload}..a${node.payload + node.child1}`;
    case CoreTag.Case:
      return `alternatives=k${node.payload}..k${node.payload + node.child1}`;
    case CoreTag.Prim:
      return `opcode=${
        primopDeclaration(node.payload)?.name ?? node.payload
      } operands=a${node.child0}..a${node.child0 + node.child1}`;
    default:
      return node.payload === 0 ? "" : `payload=${node.payload}`;
  }
}

function coreChildren(node: CoreNode): readonly number[] {
  if (node.tag === CoreTag.Apply || node.tag === CoreTag.Case) return [node.child0];
  if (node.tag === CoreTag.Prim) return [];
  return [node.child0, node.child1, node.child2];
}

function evaluationName(mode: number): string {
  return mode === 0 ? "lazy" : "strict";
}

function surfaceTagName(tag: number): string {
  for (const [name, value] of Object.entries(ExpressionTag)) {
    if (value === tag) return name;
  }
  return `Tag${tag}`;
}

function coreTagName(tag: number): string {
  for (const [name, value] of Object.entries(CoreTag)) {
    if (value === tag) return name;
  }
  return `Tag${tag}`;
}

function binaryOperatorName(operator: number): string {
  for (const [name, value] of Object.entries(BinaryOperator)) {
    if (value === operator) return name;
  }
  return `operator${operator}`;
}

function unaryOperatorName(operator: number): string {
  for (const [name, value] of Object.entries(UnaryOperator)) {
    if (value === operator) return name;
  }
  return `operator${operator}`;
}

function formatType(type: TypeSchema | Type): string {
  switch (type.kind) {
    case "integer":
      return "i32";
    case "signed-integer-64":
      return "i64";
    case "float-32":
      return "f32";
    case "float-64":
      return "f64";
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
  const present = edges.filter((edge) => edge !== NO_INDEX);
  return `[${present.map((edge) => `${prefix}${edge}`).join(",")}]`;
}

function formatEdge(edge: number, prefix: string): string {
  return edge === NO_INDEX ? "-" : `${prefix}${edge}`;
}

function symbol(module: EncodedModule, id: number): string {
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
