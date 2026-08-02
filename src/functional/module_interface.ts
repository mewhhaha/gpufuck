import {
  DEFINITION_WORD_LENGTH,
  DefinitionWord,
  type Diagnostic,
  type EncodedModule,
} from "./abi.ts";
import type { CompilerPerformanceTrace } from "../compiler_performance_trace.ts";
import { inferTypes } from "../semantic/type_inference.ts";
import type { TypeSchema } from "./schema_contract.ts";

export interface InferredDefinitionScheme {
  readonly definitionIndex: number;
  readonly name: string;
  readonly type: TypeSchema;
}

export type ModuleInterfaceInferenceResult =
  | {
    readonly ok: true;
    readonly definitions: readonly InferredDefinitionScheme[];
  }
  | {
    readonly ok: false;
    readonly diagnostics: readonly [Diagnostic, ...Diagnostic[]];
  };

/** Infers the reusable type scheme of every top-level definition in declaration order. */
export function inferModuleDefinitionSchemes(
  module: EncodedModule,
  trace?: CompilerPerformanceTrace,
): ModuleInterfaceInferenceResult {
  const inference = inferTypes(module, trace);
  if (!inference.ok) {
    return {
      ok: false,
      diagnostics: [{ ...inference.diagnostic, stage: "compile" }],
    };
  }
  return {
    ok: true,
    definitions: Object.freeze(
      inference.definitionSchemes.map((type, definitionIndex) => {
        const symbol = module.definitionWords[
          definitionIndex * DEFINITION_WORD_LENGTH + DefinitionWord.Symbol
        ];
        const name = symbol === undefined ? undefined : module.symbolNames[symbol];
        if (name === undefined) {
          throw new Error(
            `functional module interface definition ${definitionIndex} references missing symbol ${symbol}`,
          );
        }
        return Object.freeze({ definitionIndex, name, type });
      }),
    ),
  };
}
