import { type GpuFunctionalCompiler, runFunctionalWasmModule } from "../../../functional.ts";
import type { Test262ExecutionMode, Test262Metadata } from "./test262.ts";
import { lowerTest262NegativeTest, lowerTest262PositiveTest } from "./test262_harness.ts";

export const TEST262_COMPILATION_OPTIONS = Object.freeze({
  maximumSteps: 10_000_000,
  maximumStepsPerDispatch: 16_384,
});

export interface Test262ExecutionCase {
  readonly absolutePath: string;
  readonly path: string;
  readonly mode: Test262ExecutionMode;
  readonly metadata: Test262Metadata;
  readonly expectedRuntimeErrorType: string | null;
}

export interface Test262ExecutionRequest {
  readonly executionCase: Test262ExecutionCase;
  readonly entryName: string;
}

export type Test262ExecutionCaseResult =
  | {
    readonly kind: "passed";
    readonly expectation: "positive" | "runtime-negative";
  }
  | {
    readonly kind: "resource-limited" | "compilation-failed" | "execution-failed";
    readonly reason: string;
  };

export type Test262ExecutionResponse =
  | { readonly ok: true; readonly result: Test262ExecutionCaseResult }
  | { readonly ok: false; readonly message: string; readonly stack: string | null };

export async function executeTest262Case(
  compiler: GpuFunctionalCompiler,
  request: Test262ExecutionRequest,
): Promise<Test262ExecutionCaseResult> {
  const testCase = request.executionCase;
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
      `Test262 case ${JSON.stringify(testCase.path)} changed readiness before execution: ${reason}`,
    );
  }
  const runtimeNegativeValidation = "kind" in lowered ? lowered.validation : null;
  const compilation = await compiler.compileModule(
    lowered.lowered.module,
    TEST262_COMPILATION_OPTIONS,
  ).catch((error) => {
    throw new Error(
      `Test262 case ${
        JSON.stringify(testCase.path)
      } in ${testCase.mode} mode triggered a compiler invariant.`,
      { cause: error },
    );
  });
  if (!compilation.ok) {
    const primaryDiagnostic = JSON.stringify(compilation.diagnostics[0]);
    if (compilation.diagnostics.some((diagnostic) => diagnostic.code === "F1003")) {
      return {
        kind: "resource-limited",
        reason: `GPU compilation exhausted its step limit: ${primaryDiagnostic}`,
      };
    }
    return {
      kind: "compilation-failed",
      reason: `GPU compilation failed: ${primaryDiagnostic}`,
    };
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
    return {
      kind: "passed",
      expectation: expectedRuntimeErrorType === null ? "positive" : "runtime-negative",
    };
  } catch (error) {
    if (
      runtimeNegativeValidation === "runtime-fault" &&
      error instanceof Error &&
      error.message.includes(`${expectedRuntimeErrorType}:`)
    ) {
      return { kind: "passed", expectation: "runtime-negative" };
    }
    return {
      kind: "execution-failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    compilation.module.destroy();
  }
}
