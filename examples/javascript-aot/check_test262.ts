import {
  classifyTest262CoreTest,
  parseTest262Metadata,
  type Test262ExecutionMode,
  test262ExecutionModes,
} from "./src/test262.ts";
import type {
  Test262ExecutionBatchRequest,
  Test262ExecutionBatchResponse,
  Test262ExecutionBatchResult,
  Test262ExecutionCase,
} from "./src/test262_execute.ts";
import type {
  Test262FrontendBatchRequest,
  Test262FrontendBatchResponse,
  Test262FrontendFileProbe,
} from "./src/test262_scan.ts";

const TEST262_REPOSITORY = "https://github.com/tc39/test262.git";
const TEST262_COMMIT = "9e61c12835c5e4a3bdba93850427e6742c4f64c4";
const PROBE_ENTRY = "__test262_main";
const FAILURE_EXAMPLE_LIMIT = 20;
const FRONTEND_BATCH_SIZE = 64;
const EXECUTION_BATCH_SIZE = 8;
const EXECUTION_CONCURRENCY = 2;
const EXECUTION_MAX_RSS_KIB = 786_432;
const EXECUTION_TIMEOUT_MILLISECONDS = 60_000;

interface FrontendFailureExample {
  readonly path: string;
  readonly mode: Test262ExecutionMode;
  readonly stage: "parse" | "lower";
  readonly message: string;
}

const suppliedCheckout = Deno.args.find((argument) => !argument.startsWith("--"));
const reportProgress = Deno.args.includes("--progress");
const pathFilter = Deno.args.find((argument) => argument.startsWith("--filter="))?.slice(
  "--filter=".length,
);
const reportPath = Deno.args.find((argument) => argument.startsWith("--report="))?.slice(
  "--report=".length,
);
if (reportPath !== undefined && reportPath.length === 0) {
  throw new Error("Test262 report path must be nonempty.");
}
const temporaryRoot = suppliedCheckout === undefined
  ? await Deno.makeTempDir({ prefix: "gpufuck-test262-" })
  : null;
const checkout = suppliedCheckout ?? `${temporaryRoot}/test262`;

try {
  if (suppliedCheckout === undefined) {
    await runGit([
      "clone",
      "--quiet",
      "--filter=blob:none",
      "--no-checkout",
      TEST262_REPOSITORY,
      checkout,
    ]);
    await runGit(["-C", checkout, "checkout", "--quiet", TEST262_COMMIT]);
  }
  const actualCommit = (await runGit(["-C", checkout, "rev-parse", "HEAD"])).trim();
  if (actualCommit !== TEST262_COMMIT) {
    throw new Error(
      `Test262 checkout ${
        JSON.stringify(checkout)
      } is at ${actualCommit}; expected ${TEST262_COMMIT}.`,
    );
  }

  const collectedPaths = await collectJavaScriptPaths(`${checkout}/test/language`);
  const paths = pathFilter === undefined
    ? collectedPaths
    : collectedPaths.filter((path) => path.includes(pathFilter));
  if (paths.length === 0) {
    throw new Error(`Test262 path filter ${JSON.stringify(pathFilter)} matched no tests.`);
  }
  let fixtureCount = 0;
  let applicableCount = 0;
  let applicableExecutionCount = 0;
  let dynamicCodeExclusionCount = 0;
  let positiveCount = 0;
  let negativeParseCount = 0;
  let negativeResolutionCount = 0;
  let negativeRuntimeCount = 0;
  let moduleCount = 0;
  let asyncCount = 0;
  let frontendReadyCount = 0;
  let fullyReadyFileCount = 0;
  let negativePhasePassedCount = 0;
  let negativeRuntimeReadyCount = 0;
  let fullyReadyNegativeFileCount = 0;
  let parseUnsupportedCount = 0;
  let lowerUnsupportedCount = 0;
  const failureExamples: FrontendFailureExample[] = [];
  const readyExamples: string[] = [];
  const readyCases: Test262ExecutionCase[] = [];
  const parseFailureTokens = new Map<string, number>();
  const parseFailureLexemes = new Map<string, number>();
  const parseFailureLexemeExamples = new Map<string, string>();
  const lowerFailureReasons = new Map<string, number>();
  const lowerFailureExamples = new Map<string, string>();

  for (let batchStart = 0; batchStart < paths.length; batchStart += FRONTEND_BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + FRONTEND_BATCH_SIZE, paths.length);
    const probes = await probeFrontendBatchInProcess({
      checkout,
      absolutePaths: paths.slice(batchStart, batchEnd),
      entryName: PROBE_ENTRY,
    });
    for (const probe of probes) {
      if (probe.kind === "fixture") {
        fixtureCount++;
        continue;
      }
      if (probe.kind === "excluded") {
        dynamicCodeExclusionCount++;
        continue;
      }
      applicableCount++;
      applicableExecutionCount += probe.executionModes.length;
      if (probe.metadata.flags.includes("module")) moduleCount++;
      if (probe.metadata.flags.includes("async")) asyncCount++;
      const negativeExpectation = probe.metadata.negative;
      if (negativeExpectation !== null) {
        switch (negativeExpectation.phase) {
          case "parse":
            negativeParseCount++;
            break;
          case "resolution":
            negativeResolutionCount++;
            break;
          case "runtime":
            negativeRuntimeCount++;
            break;
        }
      } else {
        positiveCount++;
      }

      let readyModeCount = 0;
      for (const outcome of probe.outcomes) {
        if (outcome.kind === "ready") {
          if (negativeExpectation !== null) {
            throw new Error(
              `Negative Test262 test ${JSON.stringify(probe.path)} produced a positive outcome.`,
            );
          }
          frontendReadyCount++;
          readyModeCount++;
          readyCases.push({
            absolutePath: probe.absolutePath,
            path: probe.path,
            mode: outcome.mode,
            metadata: probe.metadata,
            expectedRuntimeErrorType: null,
          });
          if (readyExamples.length < FAILURE_EXAMPLE_LIMIT) {
            readyExamples.push(`${probe.path} [${outcome.mode}]`);
          }
          continue;
        }
        if (outcome.kind === "negative-ready") {
          if (negativeExpectation === null) {
            throw new Error(
              `Positive Test262 test ${JSON.stringify(probe.path)} produced a negative outcome.`,
            );
          }
          readyModeCount++;
          if (outcome.phase === "runtime") {
            negativeRuntimeReadyCount++;
            readyCases.push({
              absolutePath: probe.absolutePath,
              path: probe.path,
              mode: outcome.mode,
              metadata: probe.metadata,
              expectedRuntimeErrorType: outcome.expectedType,
            });
          } else {
            negativePhasePassedCount++;
          }
          continue;
        }
        const diagnostic = outcome.diagnostic;
        if (diagnostic.stage === "parse") {
          parseUnsupportedCount++;
          const token = /Unexpected token (.+?)\./.exec(diagnostic.message)?.[1] ?? "other";
          parseFailureTokens.set(token, (parseFailureTokens.get(token) ?? 0) + 1);
          if (outcome.lexeme === null && negativeExpectation === null) {
            throw new Error(
              `Test262 parse diagnostic ${diagnostic.code} for ${
                JSON.stringify(probe.path)
              } has no source lexeme.`,
            );
          }
          if (outcome.lexeme !== null) {
            parseFailureLexemes.set(
              outcome.lexeme,
              (parseFailureLexemes.get(outcome.lexeme) ?? 0) + 1,
            );
            if (!parseFailureLexemeExamples.has(outcome.lexeme)) {
              parseFailureLexemeExamples.set(
                outcome.lexeme,
                `${probe.path} [${outcome.mode}]`,
              );
            }
          }
        } else {
          lowerUnsupportedCount++;
          const reason = normalizeLowerFailureReason(diagnostic.message);
          lowerFailureReasons.set(reason, (lowerFailureReasons.get(reason) ?? 0) + 1);
          if (!lowerFailureExamples.has(reason)) {
            lowerFailureExamples.set(reason, `${probe.path} [${outcome.mode}]`);
          }
        }
        if (failureExamples.length < FAILURE_EXAMPLE_LIMIT) {
          failureExamples.push({
            path: probe.path,
            mode: outcome.mode,
            stage: diagnostic.stage,
            message: diagnostic.message,
          });
        }
      }
      if (readyModeCount === probe.executionModes.length) {
        if (negativeExpectation === null) fullyReadyFileCount++;
        else fullyReadyNegativeFileCount++;
      }
    }
    if (reportProgress) {
      console.error(`Test262 frontend paths ${batchEnd}/${paths.length}`);
    }
  }

  const execution = await executeReadyCases(readyCases);

  const report = {
    test262Commit: actualCommit,
    scope: "test/language",
    pathFilter: pathFilter ?? null,
    standaloneTestCount: paths.length - fixtureCount,
    fixtureCount,
    applicableCount,
    applicableExecutionCount,
    exclusions: {
      dynamicCodeGeneration: dynamicCodeExclusionCount,
    },
    expectations: {
      positive: positiveCount,
      negativeParse: negativeParseCount,
      negativeResolution: negativeResolutionCount,
      negativeRuntime: negativeRuntimeCount,
    },
    flags: {
      module: moduleCount,
      async: asyncCount,
    },
    frontendReadiness: {
      note:
        "Readiness counts required execution modes that adapt to Functional Core; it is not a conformance pass.",
      ready: frontendReadyCount,
      fullyReadyFiles: fullyReadyFileCount,
      parseUnsupported: parseUnsupportedCount,
      lowerUnsupported: lowerUnsupportedCount,
    },
    negativeValidation: {
      exactParseOrResolutionModesPassed: negativePhasePassedCount,
      runtimeModesReady: negativeRuntimeReadyCount,
      fullyReadyFiles: fullyReadyNegativeFileCount,
    },
    adaptedExecution: execution,
    mostCommonParseFailureTokens: [...parseFailureTokens]
      .sort((left, right) => right[1] - left[1])
      .slice(0, FAILURE_EXAMPLE_LIMIT)
      .map(([token, count]) => ({ token, count })),
    mostCommonParseFailureLexemes: [...parseFailureLexemes]
      .sort((left, right) => right[1] - left[1])
      .slice(0, FAILURE_EXAMPLE_LIMIT)
      .map(([lexeme, count]) => ({
        lexeme,
        count,
        example: parseFailureLexemeExamples.get(lexeme),
      })),
    mostCommonLowerFailureReasons: [...lowerFailureReasons]
      .sort((left, right) => right[1] - left[1])
      .slice(0, FAILURE_EXAMPLE_LIMIT)
      .map(([reason, count]) => ({
        reason,
        count,
        example: lowerFailureExamples.get(reason),
      })),
    readyExamples,
    failureExamples,
  };
  const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
  console.log(serializedReport.trimEnd());
  if (reportPath !== undefined) await Deno.writeTextFile(reportPath, serializedReport);
  if (execution.compilationFailed > 0 || execution.executionFailed > 0) {
    Deno.exitCode = 1;
  }
} finally {
  if (temporaryRoot !== null) await Deno.remove(temporaryRoot, { recursive: true });
}

async function probeFrontendBatchInProcess(
  request: Test262FrontendBatchRequest,
): Promise<readonly Test262FrontendFileProbe[]> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--v8-flags=--max-old-space-size=512",
      "--allow-read",
      new URL("./src/test262_scan_process.ts", import.meta.url).href,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const process = command.spawn();
  const writer = process.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(request)));
  await writer.close();
  const output = await process.output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr).trim();
    if (output.code === 133 && stderr.includes("heap limit")) {
      if (request.absolutePaths.length > 1) {
        const isolated: Test262FrontendFileProbe[] = [];
        for (const absolutePath of request.absolutePaths) {
          isolated.push(
            ...await probeFrontendBatchInProcess({
              ...request,
              absolutePaths: [absolutePath],
            }),
          );
        }
        return isolated;
      }
      return [await heapLimitedFrontendProbe(request, request.absolutePaths[0]!)];
    }
    throw new Error(
      `Test262 frontend subprocess failed with exit code ${output.code} for ${
        JSON.stringify(request.absolutePaths[0])
      } through ${JSON.stringify(request.absolutePaths.at(-1))}: ${stderr}`,
    );
  }
  const response = JSON.parse(
    new TextDecoder().decode(output.stdout),
  ) as Test262FrontendBatchResponse;
  if (response.ok) return response.probes;
  throw new Error(`Test262 frontend subprocess failed: ${response.message}`, {
    cause: response.stack,
  });
}

async function heapLimitedFrontendProbe(
  request: Test262FrontendBatchRequest,
  absolutePath: string,
): Promise<Test262FrontendFileProbe> {
  const prefix = `${request.checkout}/`;
  if (!absolutePath.startsWith(prefix)) {
    throw new Error(
      `Test262 path ${JSON.stringify(absolutePath)} is outside checkout ${
        JSON.stringify(request.checkout)
      }.`,
    );
  }
  const path = absolutePath.slice(prefix.length);
  const disposition = classifyTest262CoreTest(path);
  if (disposition.kind === "fixture") return { kind: "fixture", absolutePath, path };
  if (disposition.kind === "excluded") return { kind: "excluded", absolutePath, path };
  const source = await Deno.readTextFile(absolutePath);
  const metadata = parseTest262Metadata(path, source);
  const executionModes = test262ExecutionModes(metadata);
  const sourceByteLength = new TextEncoder().encode(source).byteLength;
  return {
    kind: "applicable",
    absolutePath,
    path,
    metadata,
    executionModes,
    outcomes: executionModes.map((mode) => ({
      kind: "unsupported",
      mode,
      diagnostic: {
        stage: "lower",
        code: "J1002",
        module: path,
        span: { startByte: 0, endByte: sourceByteLength },
        message: `JavaScript AOT lowering for ${
          JSON.stringify(path)
        } exhausted the isolated Test262 worker heap.`,
      },
      lexeme: null,
    })),
  };
}

function normalizeLowerFailureReason(message: string): string {
  return message.replace(/module "(?:[^"\\]|\\.)*"/, 'module "…"');
}

async function executeReadyCases(cases: readonly Test262ExecutionCase[]): Promise<{
  readonly note: string;
  readonly passed: number;
  readonly positivePassed: number;
  readonly runtimeNegativePassed: number;
  readonly compilationFailed: number;
  readonly executionFailed: number;
  readonly compilationFailureExamples: readonly string[];
  readonly executionFailureExamples: readonly string[];
}> {
  const totals = {
    passed: 0,
    positivePassed: 0,
    runtimeNegativePassed: 0,
    compilationFailed: 0,
    executionFailed: 0,
  };
  const compilationFailureExamples: string[] = [];
  const executionFailureExamples: string[] = [];
  const waveSize = EXECUTION_BATCH_SIZE * EXECUTION_CONCURRENCY;
  for (let waveStart = 0; waveStart < cases.length; waveStart += waveSize) {
    const waveEnd = Math.min(waveStart + waveSize, cases.length);
    const results = await Promise.all(
      Array.from(
        { length: Math.ceil((waveEnd - waveStart) / EXECUTION_BATCH_SIZE) },
        (_, batchIndex) => {
          const batchStart = waveStart + batchIndex * EXECUTION_BATCH_SIZE;
          return executeReadyBatchInProcess({
            cases: cases.slice(batchStart, Math.min(batchStart + EXECUTION_BATCH_SIZE, waveEnd)),
            entryName: PROBE_ENTRY,
          });
        },
      ),
    );
    for (const result of results) {
      totals.passed += result.passed;
      totals.positivePassed += result.positivePassed;
      totals.runtimeNegativePassed += result.runtimeNegativePassed;
      totals.compilationFailed += result.compilationFailed;
      totals.executionFailed += result.executionFailed;
      compilationFailureExamples.push(...result.compilationFailureExamples);
      executionFailureExamples.push(...result.executionFailureExamples);
      if (compilationFailureExamples.length > FAILURE_EXAMPLE_LIMIT) {
        compilationFailureExamples.length = FAILURE_EXAMPLE_LIMIT;
      }
      if (executionFailureExamples.length > FAILURE_EXAMPLE_LIMIT) {
        executionFailureExamples.length = FAILURE_EXAMPLE_LIMIT;
      }
    }
    if (reportProgress) {
      console.error(`Test262 adapted executions ${waveEnd}/${cases.length}`);
    }
  }
  return {
    note:
      "Each ready positive or runtime-negative mode compiles to a fresh artifact and executes once; exact Realm and harness parity remain pending.",
    ...totals,
    compilationFailureExamples,
    executionFailureExamples,
  };
}

async function executeReadyBatchInProcess(
  request: Test262ExecutionBatchRequest,
): Promise<Test262ExecutionBatchResult> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--v8-flags=--max-old-space-size=512",
      "--allow-read",
      new URL("./src/test262_execute_process.ts", import.meta.url).href,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const process = command.spawn();
  const writer = process.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(request)));
  await writer.close();
  let resourceFailure: string | null = null;
  let workerCompleted = false;
  const timeout = setTimeout(() => {
    if (workerCompleted) return;
    resourceFailure = `exceeded ${EXECUTION_TIMEOUT_MILLISECONDS / 1_000} seconds`;
    try {
      process.kill("SIGKILL");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        resourceFailure += `; could not terminate worker: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
  }, EXECUTION_TIMEOUT_MILLISECONDS);
  const memoryMonitor = setInterval(async () => {
    if (workerCompleted) return;
    try {
      const measurement = await new Deno.Command("ps", {
        args: ["-o", "rss=", "-p", String(process.pid)],
        stdout: "piped",
        stderr: "null",
      }).output();
      if (workerCompleted) return;
      if (!measurement.success) return;
      const rss = Number(new TextDecoder().decode(measurement.stdout).trim());
      if (!Number.isFinite(rss) || rss <= EXECUTION_MAX_RSS_KIB) return;
      resourceFailure = `exceeded ${EXECUTION_MAX_RSS_KIB / 1024} MiB RSS`;
      process.kill("SIGKILL");
    } catch (error) {
      clearInterval(memoryMonitor);
      resourceFailure = `could not monitor RSS: ${
        error instanceof Error ? error.message : String(error)
      }`;
      try {
        process.kill("SIGKILL");
      } catch (killError) {
        if (!(killError instanceof Deno.errors.NotFound)) {
          resourceFailure += `; could not terminate worker: ${
            killError instanceof Error ? killError.message : String(killError)
          }`;
        }
      }
    }
  }, 250);
  const output = await process.output();
  workerCompleted = true;
  clearTimeout(timeout);
  clearInterval(memoryMonitor);
  if (resourceFailure !== null) {
    if (request.cases.length > 1) {
      const isolatedResults: Test262ExecutionBatchResult[] = [];
      for (const testCase of request.cases) {
        isolatedResults.push(
          await executeReadyBatchInProcess({ cases: [testCase], entryName: request.entryName }),
        );
      }
      return {
        passed: isolatedResults.reduce((sum, result) => sum + result.passed, 0),
        positivePassed: isolatedResults.reduce(
          (sum, result) => sum + result.positivePassed,
          0,
        ),
        runtimeNegativePassed: isolatedResults.reduce(
          (sum, result) => sum + result.runtimeNegativePassed,
          0,
        ),
        compilationFailed: isolatedResults.reduce(
          (sum, result) => sum + result.compilationFailed,
          0,
        ),
        executionFailed: isolatedResults.reduce(
          (sum, result) => sum + result.executionFailed,
          0,
        ),
        compilationFailureExamples: isolatedResults.flatMap((result) =>
          result.compilationFailureExamples
        ).slice(0, FAILURE_EXAMPLE_LIMIT),
        executionFailureExamples: isolatedResults.flatMap((result) =>
          result.executionFailureExamples
        ).slice(0, FAILURE_EXAMPLE_LIMIT),
      };
    }
    const testCase = request.cases[0];
    if (testCase === undefined) {
      throw new Error("Test262 execution resource limit fired for an empty batch.");
    }
    return {
      passed: 0,
      positivePassed: 0,
      runtimeNegativePassed: 0,
      compilationFailed: 1,
      executionFailed: 0,
      compilationFailureExamples: [
        `${testCase.path} [${testCase.mode}]: isolated compilation ${resourceFailure}`,
      ],
      executionFailureExamples: [],
    };
  }
  if (!output.success) {
    throw new Error(
      `Test262 execution subprocess failed with exit code ${output.code} for ${
        JSON.stringify(request.cases[0]?.path)
      } through ${JSON.stringify(request.cases.at(-1)?.path)}: ${
        new TextDecoder().decode(output.stderr).trim()
      }`,
    );
  }
  const response = JSON.parse(
    new TextDecoder().decode(output.stdout),
  ) as Test262ExecutionBatchResponse;
  if (response.ok) return response.result;
  throw new Error(`Test262 execution subprocess failed: ${response.message}`, {
    cause: response.stack,
  });
}

async function collectJavaScriptPaths(root: string): Promise<readonly string[]> {
  const paths: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory) {
      paths.push(...await collectJavaScriptPaths(path));
    } else if (entry.isFile && entry.name.endsWith(".js")) {
      paths.push(path);
    }
  }
  paths.sort();
  return paths;
}

async function runGit(arguments_: readonly string[]): Promise<string> {
  const command = new Deno.Command("git", {
    args: [...arguments_],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  if (!result.success) {
    throw new Error(
      `git ${arguments_.join(" ")} failed with exit code ${result.code}: ${
        new TextDecoder().decode(result.stderr).trim()
      }`,
    );
  }
  return new TextDecoder().decode(result.stdout);
}
