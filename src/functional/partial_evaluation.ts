import { functionalConstantExpression } from "./comptime_constant.ts";
import type {
  FunctionalComptimeExecutionOptions,
  FunctionalComptimeModuleArtifact,
  FunctionalPartialEvaluationResult,
} from "./comptime_contract.ts";
import type { GpuFunctionalComptimeExecutor } from "./comptime.ts";
import { createFunctionalModuleArtifact, type FunctionalModuleArtifact } from "./module_linker.ts";

export async function partiallyEvaluateFunctionalModule(
  executor: GpuFunctionalComptimeExecutor,
  artifact: FunctionalModuleArtifact,
  dependencies: readonly FunctionalModuleArtifact[] = [],
  options: FunctionalComptimeExecutionOptions = {},
): Promise<FunctionalPartialEvaluationResult> {
  const validated = createFunctionalModuleArtifact(artifact);
  const exportTypes = new Map(
    validated.exports.map((exported) => [exported.definition, exported.type]),
  );
  const candidates = validated.definitions.filter((definition) =>
    definition.parameters.length === 0 &&
    (definition.annotation !== null || exportTypes.has(definition.name))
  );
  const attemptedDefinitions = Object.freeze(candidates.map((definition) => definition.name));
  if (candidates.length === 0) {
    return {
      artifact: validated,
      attemptedDefinitions,
      foldedDefinitions: Object.freeze([]),
    };
  }
  const candidateExports = candidates.map((definition, index) => ({
    name: `$comptime$${index}`,
    definition: definition.name,
    type: exportTypes.get(definition.name) ?? definition.annotation!,
  }));
  const target: FunctionalComptimeModuleArtifact = {
    name: validated.name,
    definitions: validated.definitions,
    typeDeclarations: validated.typeDeclarations,
    imports: validated.imports,
    exports: candidateExports,
    sourceByteLength: validated.sourceByteLength,
    ...(validated.options.evaluationProfile === undefined
      ? {}
      : { evaluationProfile: validated.options.evaluationProfile }),
  };
  const comptimeDependencies = dependencies.map(comptimeArtifact);
  const evaluation = await executor.executeExports(
    [...comptimeDependencies, target],
    candidateExports.map((exported) => ({
      module: validated.name,
      exportName: exported.name,
    })),
    options,
  );
  if (!evaluation.ok) {
    return {
      artifact: validated,
      attemptedDefinitions,
      foldedDefinitions: Object.freeze([]),
      skipped: evaluation.stage === "compile"
        ? { stage: "compile", diagnostics: evaluation.diagnostics }
        : evaluation.stage === "execute"
        ? { stage: "execute", fault: evaluation.fault }
        : { stage: "comptime", diagnostic: evaluation.diagnostic },
    };
  }
  const constants = new Map(
    evaluation.exports.map((exported) => [exported.definition, exported.value]),
  );
  const foldedDefinitions = Object.freeze([...constants.keys()]);
  const definitions = validated.definitions.map((definition) => {
    const constant = constants.get(definition.name);
    if (constant === undefined) return definition;
    return {
      ...definition,
      body: functionalConstantExpression(constant, definition.span),
    };
  });
  return {
    artifact: createFunctionalModuleArtifact({ ...validated, definitions }),
    attemptedDefinitions,
    foldedDefinitions,
  };
}

function comptimeArtifact(artifact: FunctionalModuleArtifact): FunctionalComptimeModuleArtifact {
  return {
    name: artifact.name,
    definitions: artifact.definitions,
    typeDeclarations: artifact.typeDeclarations,
    imports: artifact.imports,
    exports: artifact.exports,
    sourceByteLength: artifact.sourceByteLength,
    ...(artifact.options.evaluationProfile === undefined
      ? {}
      : { evaluationProfile: artifact.options.evaluationProfile }),
  };
}
