import { CoreTag, EvaluationMode, NO_INDEX } from "./abi.ts";
import {
  type CompilerPerformanceTrace,
  measureCompilerStage,
} from "../compiler_performance_trace.ts";
import type { CompiledModule, CoreNode } from "./compiler_module.ts";
import { type EffectSet, effectSet, effectSetFrom } from "./effect_set.ts";
import type { PreparedWasmLambdaAnalysis } from "./prepared_wasm_lambda_analysis.ts";
import { LambdaSetAnalysis } from "./wasm_lambda_sets.ts";
import { lowerCoreForWasm } from "./wasm_core_lowering.ts";

export interface ModuleEffectAnalysis {
  readonly definitionEffects: readonly EffectSet[];
  readonly entryEffects: EffectSet;
  readonly wasmLambdaAnalysis?: PreparedWasmLambdaAnalysis;
}

/**
 * Computes a conservative may-effect summary. Alternatives and lazy operands are unioned because
 * an effect-free backend must remain valid for every execution path.
 */
export function analyzeModuleEffects(
  module: CompiledModule,
  nodes: readonly CoreNode[],
  trace?: CompilerPerformanceTrace,
): ModuleEffectAnalysis {
  if (nodes.length !== module.nodeCount) {
    throw new Error(
      `functional effect analysis received ${nodes.length} Core nodes; module declares ${module.nodeCount}`,
    );
  }
  const moduleIsPure = module.declaredDefinitionEffects.every((effects) => effects.size === 0) &&
    module.hostCapabilities.every((capability) =>
      capability.fields.every((field) => field.kind === "value" || field.effects.size === 0)
    );
  if (moduleIsPure) {
    const empty = effectSet();
    return Object.freeze({
      definitionEffects: Object.freeze(
        Array.from({ length: module.definitionCount }, () => empty),
      ),
      entryEffects: empty,
    });
  }
  const loweringAnnotations = { inputNodes: nodes.length, outputNodes: 0 };
  const wasmNodes = measureCompilerStage(
    trace,
    "semantic.effects.lower-wasm-core",
    loweringAnnotations,
    () => lowerCoreForWasm(module, nodes),
    (result) => {
      loweringAnnotations.outputNodes = result.length;
    },
  );
  const lambdaSets = measureCompilerStage(
    trace,
    "semantic.effects.lambda-sets",
    { nodes: wasmNodes.length, definitions: module.definitionCount },
    () => LambdaSetAnalysis.forWasm(module, wasmNodes),
  );
  const effectNamesByNode: (Set<string> | undefined)[] = new Array(nodes.length);
  const dependents: (Set<number> | undefined)[] = new Array(nodes.length);
  const hostEffectsByDefinition = new Map(
    module.hostDefinitions.map((binding) => {
      const definition = module.definitionNames.indexOf(binding.definition);
      const capability = module.hostCapabilities.find((candidate) =>
        candidate.name === binding.capability
      );
      const field = capability?.fields.find((candidate) => candidate.name === binding.field);
      if (definition < 0 || field === undefined) {
        throw new Error(
          `functional effect analysis host definition ${
            JSON.stringify(binding.definition)
          } could not resolve ${JSON.stringify(`${binding.capability}.${binding.field}`)}`,
        );
      }
      return [definition, field.kind === "operation" ? field.effects : effectSet()] as const;
    }),
  );

  const dependOn = (nodeIndex: number, dependency: number): void => {
    if (dependency === NO_INDEX) return;
    if (nodes[dependency] === undefined) {
      throw new Error(
        `functional effect analysis node ${nodeIndex} depends on missing node ${dependency}`,
      );
    }
    (dependents[dependency] ??= new Set()).add(nodeIndex);
  };

  measureCompilerStage(
    trace,
    "semantic.effects.graph",
    { nodes: nodes.length },
    () => {
      for (const [nodeIndex, node] of nodes.entries()) {
        switch (node.tag) {
          case CoreTag.SignedInteger64:
          case CoreTag.Float64:
          case CoreTag.WholeNumberF64:
          case CoreTag.Integer:
          case CoreTag.Float32:
          case CoreTag.Boolean:
          case CoreTag.Text:
          case CoreTag.Bytes:
          case CoreTag.RuntimeFault:
          case CoreTag.StoreEmpty:
          case CoreTag.Local:
          case CoreTag.Constructor:
          case CoreTag.Lambda:
            break;
          case CoreTag.Global: {
            if (hostEffectsByDefinition.has(node.payload)) break;
            const root = module.definitionRoots[node.payload];
            if (root === undefined) {
              throw new Error(
                `functional effect analysis global d${node.payload} exceeds ${module.definitionCount} definitions`,
              );
            }
            if (nodes[root]?.tag !== CoreTag.Lambda) {
              for (const effect of module.declaredDefinitionEffects[node.payload]!) {
                (effectNamesByNode[nodeIndex] ??= new Set()).add(effect);
              }
              dependOn(nodeIndex, root);
            }
            break;
          }
          case CoreTag.Apply: {
            dependOn(nodeIndex, node.child0);
            for (
              let argument = node.payload;
              argument < node.payload + node.child1;
              argument++
            ) {
              dependOn(nodeIndex, module.arguments[argument]!.node);
            }
            lambdaSets.forEachLambdaSetMember(
              node.child0,
              (lambdaNode) => {
                const lambda = nodes[lambdaNode];
                if (lambda?.tag !== CoreTag.Lambda) {
                  throw new Error(
                    `functional effect analysis callable node ${lambdaNode} is not a lambda`,
                  );
                }
                dependOn(nodeIndex, lambda.child0);
              },
              (effect) => (effectNamesByNode[nodeIndex] ??= new Set()).add(effect),
            );
            break;
          }
          case CoreTag.Prim:
            for (let operand = node.child0; operand < node.child0 + node.child1; operand++) {
              dependOn(nodeIndex, module.arguments[operand]!.node);
            }
            break;
          case CoreTag.Unary:
          case CoreTag.NumericConvert:
          case CoreTag.StoreLength:
            dependOn(nodeIndex, node.child0);
            break;
          case CoreTag.Binary:
          case CoreTag.BufferAppend:
          case CoreTag.StoreNew:
          case CoreTag.StoreRead:
          case CoreTag.LetRec:
            dependOn(nodeIndex, node.child0);
            dependOn(nodeIndex, node.child1);
            break;
          case CoreTag.Let:
            if (node.evaluationMode === EvaluationMode.StrictEager || node.payload > 0) {
              dependOn(nodeIndex, node.child0);
            }
            dependOn(nodeIndex, node.child1);
            break;
          case CoreTag.Case:
            dependOn(nodeIndex, node.child0);
            for (
              let alternative = node.payload;
              alternative < node.payload + node.child1;
              alternative++
            ) {
              dependOn(nodeIndex, module.caseAlternatives[alternative]!.body);
            }
            break;
          case CoreTag.If:
          case CoreTag.StoreWrite:
          case CoreTag.StoreGrow:
            dependOn(nodeIndex, node.child0);
            dependOn(nodeIndex, node.child1);
            dependOn(nodeIndex, node.child2);
            break;
        }
      }
    },
  );

  const pending = effectNamesByNode.flatMap((effects, nodeIndex) =>
    effects === undefined || effects.size === 0 ? [] : [nodeIndex]
  );
  const queued = new Set(pending);
  measureCompilerStage(
    trace,
    "semantic.effects.propagate",
    { initialNodes: pending.length },
    () => {
      while (pending.length > 0) {
        const source = pending.pop()!;
        queued.delete(source);
        for (const dependent of dependents[source] ?? []) {
          const targetEffects = effectNamesByNode[dependent] ??= new Set();
          const previousSize = targetEffects.size;
          for (const effect of effectNamesByNode[source]!) targetEffects.add(effect);
          if (targetEffects.size === previousSize || queued.has(dependent)) continue;
          pending.push(dependent);
          queued.add(dependent);
        }
      }
    },
  );

  const definitionEffects = measureCompilerStage(
    trace,
    "semantic.effects.materialize",
    { definitions: module.definitionCount },
    () =>
      module.definitionRoots.map((root, definition) => {
        const hostEffects = hostEffectsByDefinition.get(definition);
        if (hostEffects !== undefined) return hostEffects;
        const rootNode = nodes[root];
        if (rootNode === undefined) {
          throw new Error(
            `functional effect analysis definition d${definition} root ${root} is missing`,
          );
        }
        let effectNode = root;
        while (nodes[effectNode]?.tag === CoreTag.Lambda) {
          effectNode = nodes[effectNode]!.child0;
        }
        return effectSetFrom([
          ...module.declaredDefinitionEffects[definition]!,
          ...(effectNamesByNode[effectNode] ?? []),
        ]);
      }),
  );
  const entryEffects = definitionEffects[module.entryDefinition];
  if (entryEffects === undefined) {
    throw new Error(
      `functional effect analysis entry d${module.entryDefinition} exceeds ${module.definitionCount} definitions`,
    );
  }
  return Object.freeze({
    definitionEffects: Object.freeze(definitionEffects),
    entryEffects,
    wasmLambdaAnalysis: Object.freeze({ nodes: wasmNodes, lambdaSets }),
  });
}
