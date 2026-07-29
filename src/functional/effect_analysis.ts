import { CoreTag, NO_INDEX } from "./abi.ts";
import type { CoreNode, GpuModule } from "./compiler_module.ts";
import { type EffectSet, effectSet, effectSetFrom } from "./effect_set.ts";
import { LambdaSetAnalysis } from "./wasm_lambda_sets.ts";

export interface ModuleEffectAnalysis {
  readonly definitionEffects: readonly EffectSet[];
  readonly entryEffects: EffectSet;
}

/**
 * Computes a conservative may-effect summary. Alternatives and lazy operands are unioned because
 * an effect-free backend must remain valid for every execution path.
 */
export function analyzeModuleEffects(
  module: GpuModule,
  nodes: readonly CoreNode[],
): ModuleEffectAnalysis {
  if (nodes.length !== module.nodeCount) {
    throw new Error(
      `functional effect analysis received ${nodes.length} Core nodes; module declares ${module.nodeCount}`,
    );
  }
  const lambdaSets = new LambdaSetAnalysis(module, nodes);
  const effectNamesByNode = Array.from(
    { length: nodes.length },
    () => new Set<string>(),
  );
  const dependents = Array.from(
    { length: nodes.length },
    () => new Set<number>(),
  );
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
    dependents[dependency]!.add(nodeIndex);
  };

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
            effectNamesByNode[nodeIndex]!.add(effect);
          }
          dependOn(nodeIndex, root);
        }
        break;
      }
      case CoreTag.Apply: {
        dependOn(nodeIndex, node.child0);
        dependOn(nodeIndex, node.child1);
        const callee = lambdaSets.lambdaSet(node.child0);
        for (const effect of callee.effects) effectNamesByNode[nodeIndex]!.add(effect);
        for (const lambdaNode of callee.lambdaNodes) {
          const lambda = nodes[lambdaNode];
          if (lambda?.tag !== CoreTag.Lambda) {
            throw new Error(
              `functional effect analysis callable node ${lambdaNode} is not a lambda`,
            );
          }
          dependOn(nodeIndex, lambda.child0);
        }
        break;
      }
      case CoreTag.Unary:
      case CoreTag.NumericConvert:
      case CoreTag.StoreLength:
      case CoreTag.PatternBind:
        dependOn(nodeIndex, node.child0);
        break;
      case CoreTag.Binary:
      case CoreTag.BufferAppend:
      case CoreTag.StoreNew:
      case CoreTag.StoreRead:
      case CoreTag.Let:
      case CoreTag.LetRec:
      case CoreTag.Case:
      case CoreTag.CaseArm:
        dependOn(nodeIndex, node.child0);
        dependOn(nodeIndex, node.child1);
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

  const pending = effectNamesByNode.flatMap((effects, nodeIndex) =>
    effects.size === 0 ? [] : [nodeIndex]
  );
  const queued = new Set(pending);
  while (pending.length > 0) {
    const source = pending.pop()!;
    queued.delete(source);
    for (const dependent of dependents[source]!) {
      const targetEffects = effectNamesByNode[dependent]!;
      const previousSize = targetEffects.size;
      for (const effect of effectNamesByNode[source]!) targetEffects.add(effect);
      if (targetEffects.size === previousSize || queued.has(dependent)) continue;
      pending.push(dependent);
      queued.add(dependent);
    }
  }

  const definitionEffects = module.definitionRoots.map((root, definition) => {
    const rootNode = nodes[root];
    if (rootNode === undefined) {
      throw new Error(
        `functional effect analysis definition d${definition} root ${root} is missing`,
      );
    }
    const effectNode = rootNode.tag === CoreTag.Lambda ? rootNode.child0 : root;
    return effectSetFrom([
      ...module.declaredDefinitionEffects[definition]!,
      ...(hostEffectsByDefinition.get(definition) ?? []),
      ...effectNamesByNode[effectNode]!,
    ]);
  });
  const entryEffects = definitionEffects[module.entryDefinition];
  if (entryEffects === undefined) {
    throw new Error(
      `functional effect analysis entry d${module.entryDefinition} exceeds ${module.definitionCount} definitions`,
    );
  }
  return Object.freeze({
    definitionEffects: Object.freeze(definitionEffects),
    entryEffects,
  });
}
