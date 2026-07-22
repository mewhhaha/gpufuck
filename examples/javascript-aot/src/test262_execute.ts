import {
  GpuFunctionalCompiler,
  requestWebGpuDevice,
  runFunctionalWasmModule,
} from "../../../functional.ts";
import type { Test262ExecutionMode, Test262Metadata } from "./test262.ts";
import { lowerTest262NegativeTest, lowerTest262PositiveTest } from "./test262_harness.ts";

const FAILURE_EXAMPLE_LIMIT = 20;

export interface Test262ExecutionCase {
  readonly absolutePath: string;
  readonly path: string;
  readonly mode: Test262ExecutionMode;
  readonly metadata: Test262Metadata;
  readonly expectedRuntimeErrorType: string | null;
}

export interface Test262ExecutionBatchRequest {
  readonly cases: readonly Test262ExecutionCase[];
  readonly entryName: string;
}

export interface Test262ExecutionBatchResult {
  readonly passed: number;
  readonly positivePassed: number;
  readonly runtimeNegativePassed: number;
  readonly compilationFailed: number;
  readonly executionFailed: number;
  readonly compilationFailureExamples: readonly string[];
  readonly executionFailureExamples: readonly string[];
}

export type Test262ExecutionBatchResponse =
  | { readonly ok: true; readonly result: Test262ExecutionBatchResult }
  | { readonly ok: false; readonly message: string; readonly stack: string | null };

export async function executeTest262Batch(
  request: Test262ExecutionBatchRequest,
): Promise<Test262ExecutionBatchResult> {
  const device = await requestWebGpuDevice();
  let passed = 0;
  let positivePassed = 0;
  let runtimeNegativePassed = 0;
  let compilationFailed = 0;
  let executionFailed = 0;
  const compilationFailureExamples: string[] = [];
  const executionFailureExamples: string[] = [];
  try {
    const compiler = await GpuFunctionalCompiler.create(device);
    for (const testCase of request.cases) {
      const source = await Deno.readTextFile(testCase.absolutePath);
      const expectedRuntimeErrorType = testCase.expectedRuntimeErrorType;
      const lowered = expectedRuntimeErrorType === null
        ? lowerTest262PositiveTest(
          testCase.path,
          source,
          testCase.metadata,
          request.entryName,
          testCase.mode,
        )
        : lowerTest262NegativeTest(
          testCase.path,
          source,
          testCase.metadata,
          request.entryName,
          testCase.mode,
        );
      if ("ok" in lowered && !lowered.ok) {
        throw new Error(
          `Test262 case ${JSON.stringify(testCase.path)} changed readiness before execution: ${
            lowered.diagnostics[0].message
          }`,
        );
      }
      if ("kind" in lowered && lowered.kind !== "runtime-ready") {
        const reason = lowered.kind === "mismatch"
          ? lowered.diagnostic.message
          : `negative test reached ${lowered.phase}`;
        throw new Error(
          `Test262 case ${
            JSON.stringify(testCase.path)
          } changed readiness before execution: ${reason}`,
        );
      }
      const runtimeNegativeValidation = "kind" in lowered ? lowered.validation : null;
      const compilation = await compiler.compileModule(lowered.lowered.module).catch((error) => {
        throw new Error(
          `Test262 case ${
            JSON.stringify(testCase.path)
          } in ${testCase.mode} mode triggered a compiler invariant.`,
          { cause: error },
        );
      });
      if (!compilation.ok) {
        compilationFailed++;
        if (compilationFailureExamples.length < FAILURE_EXAMPLE_LIMIT) {
          compilationFailureExamples.push(
            `${testCase.path} [${testCase.mode}]: GPU compilation failed: ${
              JSON.stringify(compilation.diagnostics[0])
            }`,
          );
        }
        continue;
      }
      try {
        const execution = await runFunctionalWasmModule(compilation.module);
        if (runtimeNegativeValidation === "runtime-fault") {
          throw new Error(`runtime did not throw ${expectedRuntimeErrorType}`);
        }
        if (execution.value.kind !== "boolean" || !execution.value.value) {
          throw new Error(
            expectedRuntimeErrorType === null
              ? "adapted positive test returned a non-true result"
              : `runtime did not throw ${expectedRuntimeErrorType}`,
          );
        }
        passed++;
        if (expectedRuntimeErrorType === null) positivePassed++;
        else runtimeNegativePassed++;
      } catch (error) {
        if (
          runtimeNegativeValidation === "runtime-fault" &&
          error instanceof Error &&
          error.message.includes(`${expectedRuntimeErrorType}:`)
        ) {
          passed++;
          runtimeNegativePassed++;
        } else {
          executionFailed++;
          if (executionFailureExamples.length < FAILURE_EXAMPLE_LIMIT) {
            executionFailureExamples.push(
              `${testCase.path} [${testCase.mode}]: execution failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      } finally {
        compilation.module.destroy();
      }
    }
  } finally {
    device.destroy();
  }
  return {
    passed,
    positivePassed,
    runtimeNegativePassed,
    compilationFailed,
    executionFailed,
    compilationFailureExamples,
    executionFailureExamples,
  };
}
