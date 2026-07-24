import {
  classifyTest262CoreTest,
  parseTest262Metadata,
  type Test262ExecutionMode,
  test262ExecutionModes,
} from "./src/test262.ts";
import type { Test262ExecutionCase, Test262ExecutionCaseResult } from "./src/test262_execute.ts";
import type {
  Test262FrontendBatchRequest,
  Test262FrontendBatchResponse,
  Test262FrontendFileProbe,
} from "./src/test262_scan.ts";
import {
  encodeTest262WorkerMessage,
  parseTest262WorkerResponse,
  readNdjsonLines,
} from "./src/test262_worker_protocol.ts";

const TEST262_REPOSITORY = "https://github.com/tc39/test262.git";
const TEST262_COMMIT = "9e61c12835c5e4a3bdba93850427e6742c4f64c4";
const PROBE_ENTRY = "__test262_main";
const FAILURE_EXAMPLE_LIMIT = 20;
const FRONTEND_BATCH_SIZE = 64;
const EXECUTION_WORKER_COUNT = 2;
const EXECUTION_POST_READY_RSS_HEADROOM_KIB = 786_432;
const EXECUTION_WARMUP_TIMEOUT_MILLISECONDS = 180_000;
const EXECUTION_CASE_TIMEOUT_MILLISECONDS = 60_000;

interface FrontendFailureExample {
  readonly path: string;
  readonly mode: Test262ExecutionMode;
  readonly stage: "parse" | "lower";
  readonly message: string;
}

class Test262ExecutionWorker {
  readonly workerNumber: number;
  readonly #workerProcess: Deno.ChildProcess;
  readonly #requestWriter: WritableStreamDefaultWriter<Uint8Array>;
  readonly #responseLines: AsyncIterator<string>;
  readonly #stderr: Promise<string>;
  #readyRssKiB = 0;
  #nextRequestId = 0;
  #closed = false;

  private constructor(workerNumber: number, workerProcess: Deno.ChildProcess) {
    this.workerNumber = workerNumber;
    this.#workerProcess = workerProcess;
    this.#requestWriter = workerProcess.stdin.getWriter();
    this.#responseLines = readNdjsonLines(workerProcess.stdout)[Symbol.asyncIterator]();
    this.#stderr = new Response(workerProcess.stderr).text();
  }

  static async start(workerNumber: number): Promise<Test262ExecutionWorker> {
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
    const worker = new Test262ExecutionWorker(workerNumber, command.spawn());
    let warmupExpired = false;
    let warmupTerminationFailure: string | null = null;
    const warmupTimeout = setTimeout(() => {
      warmupExpired = true;
      warmupTerminationFailure = worker.#terminate();
    }, EXECUTION_WARMUP_TIMEOUT_MILLISECONDS);
    try {
      const readyLine = await worker.#responseLines.next();
      clearTimeout(warmupTimeout);
      if (warmupExpired) {
        await worker.#finishTerminatedWorker();
        throw new Error(
          `Test262 execution worker ${workerNumber} warmup exceeded ${
            EXECUTION_WARMUP_TIMEOUT_MILLISECONDS / 1_000
          } seconds${warmupTerminationFailure === null ? "" : `; ${warmupTerminationFailure}`}.`,
        );
      }
      if (readyLine.done) {
        throw await worker.#unexpectedExit("before reporting ready");
      }
      const response = parseTest262WorkerResponse(readyLine.value);
      if (response.type !== "ready") {
        throw new Error(
          `Test262 execution worker ${workerNumber} reported ${response.type} before ready.`,
        );
      }
      worker.#readyRssKiB = await residentSetSizeKiB(worker.#workerProcess.pid);
      return worker;
    } catch (error) {
      clearTimeout(warmupTimeout);
      if (!worker.#closed) {
        const terminationFailure = worker.#terminate();
        await worker.#finishTerminatedWorker();
        if (terminationFailure !== null) {
          throw new Error(
            `Test262 execution worker ${workerNumber} startup failed and ${terminationFailure}.`,
            { cause: error },
          );
        }
      }
      throw error;
    }
  }

  async execute(
    testCase: Test262ExecutionCase,
    entryName: string,
  ): Promise<Test262WorkerExecutionOutcome> {
    if (this.#closed) {
      throw new Error(`Test262 execution worker ${this.workerNumber} is closed.`);
    }
    const requestId = this.#nextRequestId++;
    try {
      await this.#requestWriter.write(encodeTest262WorkerMessage({
        type: "execute",
        requestId,
        request: { executionCase: testCase, entryName },
      }));
    } catch (error) {
      const terminationFailure = this.#terminate();
      await this.#finishTerminatedWorker();
      throw new Error(
        `Test262 execution worker ${this.workerNumber} could not accept ${
          JSON.stringify(testCase.path)
        } in ${testCase.mode} mode${terminationFailure === null ? "" : `; ${terminationFailure}`}.`,
        { cause: error },
      );
    }

    let executionFinished = false;
    let resourceFailure: string | null = null;
    let monitorFailure: string | null = null;
    let memoryMeasurementPending = false;
    const caseTimeout = setTimeout(() => {
      if (executionFinished) return;
      resourceFailure = `execution worker exceeded ${
        EXECUTION_CASE_TIMEOUT_MILLISECONDS / 1_000
      } seconds`;
      const terminationFailure = this.#terminate();
      if (terminationFailure !== null) resourceFailure += `; ${terminationFailure}`;
    }, EXECUTION_CASE_TIMEOUT_MILLISECONDS);
    const memoryMonitor = setInterval(async () => {
      if (executionFinished || memoryMeasurementPending) return;
      memoryMeasurementPending = true;
      try {
        const rssKiB = await residentSetSizeKiB(this.#workerProcess.pid);
        if (executionFinished) return;
        const rssHeadroomKiB = rssKiB - this.#readyRssKiB;
        if (rssHeadroomKiB <= EXECUTION_POST_READY_RSS_HEADROOM_KIB) return;
        resourceFailure =
          `execution worker exceeded ${
            EXECUTION_POST_READY_RSS_HEADROOM_KIB / 1024
          } MiB post-ready RSS headroom (ready ${Math.ceil(this.#readyRssKiB / 1024)} MiB, ` +
          `observed ${Math.ceil(rssKiB / 1024)} MiB)`;
        const terminationFailure = this.#terminate();
        if (terminationFailure !== null) resourceFailure += `; ${terminationFailure}`;
      } catch (error) {
        if (executionFinished || resourceFailure !== null) return;
        monitorFailure = error instanceof Error ? error.message : String(error);
        const terminationFailure = this.#terminate();
        if (terminationFailure !== null) monitorFailure += `; ${terminationFailure}`;
      } finally {
        memoryMeasurementPending = false;
      }
    }, 250);

    let responseLine: IteratorResult<string>;
    try {
      responseLine = await this.#responseLines.next();
    } catch (error) {
      executionFinished = true;
      clearTimeout(caseTimeout);
      clearInterval(memoryMonitor);
      throw new Error(
        `Test262 execution worker ${this.workerNumber} failed while executing ${
          JSON.stringify(testCase.path)
        } in ${testCase.mode} mode.`,
        { cause: error },
      );
    }
    executionFinished = true;
    clearTimeout(caseTimeout);
    clearInterval(memoryMonitor);

    if (resourceFailure !== null) {
      await this.#finishTerminatedWorker();
      return {
        result: { kind: "resource-limited", reason: resourceFailure },
        workerReusable: false,
      };
    }
    if (monitorFailure !== null) {
      await this.#finishTerminatedWorker();
      throw new Error(
        `Test262 execution worker ${this.workerNumber} could not monitor RSS while executing ${
          JSON.stringify(testCase.path)
        } in ${testCase.mode} mode: ${monitorFailure}`,
      );
    }
    if (responseLine.done) {
      throw await this.#unexpectedExit(
        `while executing ${JSON.stringify(testCase.path)} in ${testCase.mode} mode`,
      );
    }

    let workerResponse;
    try {
      workerResponse = parseTest262WorkerResponse(responseLine.value);
    } catch (error) {
      throw new Error(
        `Test262 execution worker ${this.workerNumber} returned an invalid response for ${
          JSON.stringify(testCase.path)
        } in ${testCase.mode} mode.`,
        { cause: error },
      );
    }
    if (workerResponse.type !== "result" || workerResponse.requestId !== requestId) {
      throw new Error(
        `Test262 execution worker ${this.workerNumber} returned ${
          workerResponse.type === "result"
            ? `request ${workerResponse.requestId}`
            : workerResponse.type
        } while awaiting request ${requestId} for ${
          JSON.stringify(testCase.path)
        } in ${testCase.mode} mode.`,
      );
    }
    if (!workerResponse.response.ok) {
      throw new Error(
        `Test262 execution worker ${this.workerNumber} failed ${
          JSON.stringify(testCase.path)
        } in ${testCase.mode} mode: ${workerResponse.response.message}`,
        { cause: workerResponse.response.stack },
      );
    }
    return { result: workerResponse.response.result, workerReusable: true };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#requestWriter.write(encodeTest262WorkerMessage({ type: "close" }));
    await this.#requestWriter.close();
    const status = await this.#workerProcess.status;
    const stderr = (await this.#stderr).trim();
    this.#requestWriter.releaseLock();
    if (!status.success) {
      throw new Error(
        `Test262 execution worker ${this.workerNumber} exited with code ${status.code}: ${stderr}`,
      );
    }
  }

  #terminate(): string | null {
    try {
      this.#workerProcess.kill("SIGKILL");
      return null;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      return `could not terminate worker: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  async #finishTerminatedWorker(): Promise<void> {
    this.#closed = true;
    await this.#workerProcess.status;
    await this.#stderr;
    this.#requestWriter.releaseLock();
  }

  async #unexpectedExit(phase: string): Promise<Error> {
    this.#closed = true;
    const status = await this.#workerProcess.status;
    const stderr = (await this.#stderr).trim();
    this.#requestWriter.releaseLock();
    return new Error(
      `Test262 execution worker ${this.workerNumber} exited with code ${status.code} ${phase}: ${
        stderr || "no stderr output"
      }`,
    );
  }
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
  const successfulApplicableModeCount = negativePhasePassedCount + execution.passed;
  const failedApplicableModeCount = parseUnsupportedCount +
    lowerUnsupportedCount +
    execution.resourceLimited +
    execution.compilationFailed +
    execution.executionFailed;
  if (
    successfulApplicableModeCount + failedApplicableModeCount !== applicableExecutionCount
  ) {
    throw new Error(
      `Test262 applicable-mode accounting is unbalanced: ` +
        `applicable=${applicableExecutionCount}, successful=${successfulApplicableModeCount} ` +
        `(negative-phase=${negativePhasePassedCount}, execution=${execution.passed}), ` +
        `failed=${failedApplicableModeCount} (parse-unsupported=${parseUnsupportedCount}, ` +
        `lower-unsupported=${lowerUnsupportedCount}, ` +
        `resource-limited=${execution.resourceLimited}, ` +
        `compilation=${execution.compilationFailed}, execution=${execution.executionFailed}).`,
    );
  }
  const applicableModeAccounting = {
    successful: successfulApplicableModeCount,
    failed: failedApplicableModeCount,
  };

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
    applicableModeAccounting,
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
  if (applicableModeAccounting.failed > 0) Deno.exitCode = 1;
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
  readonly resourceLimited: number;
  readonly compilationFailed: number;
  readonly executionFailed: number;
  readonly resourceLimitExamples: readonly string[];
  readonly compilationFailureExamples: readonly string[];
  readonly executionFailureExamples: readonly string[];
}> {
  const totals = {
    passed: 0,
    positivePassed: 0,
    runtimeNegativePassed: 0,
    resourceLimited: 0,
    compilationFailed: 0,
    executionFailed: 0,
  };
  const resourceLimitExamples: string[] = [];
  const compilationFailureExamples: string[] = [];
  const executionFailureExamples: string[] = [];
  if (cases.length === 0) {
    return {
      note:
        "Each ready positive or runtime-negative mode compiles to a fresh artifact and executes once; exact Realm and harness parity remain pending.",
      ...totals,
      resourceLimitExamples,
      compilationFailureExamples,
      executionFailureExamples,
    };
  }

  const workerStarts = await Promise.allSettled(
    Array.from(
      { length: Math.min(EXECUTION_WORKER_COUNT, cases.length) },
      (_, workerIndex) => Test262ExecutionWorker.start(workerIndex + 1),
    ),
  );
  const workers: Test262ExecutionWorker[] = [];
  let startupFailure: PromiseRejectedResult | null = null;
  for (const workerStart of workerStarts) {
    if (workerStart.status === "fulfilled") workers.push(workerStart.value);
    else startupFailure ??= workerStart;
  }
  if (startupFailure !== null) {
    await Promise.allSettled(workers.map((worker) => worker.close()));
    throw startupFailure.reason;
  }

  let nextCaseIndex = 0;
  let completedCaseCount = 0;
  const workerRuns = workers.map(async (initialWorker) => {
    const workerNumber = initialWorker.workerNumber;
    let worker: Test262ExecutionWorker | null = initialWorker;
    try {
      while (true) {
        const testCase = cases[nextCaseIndex++];
        if (testCase === undefined) return;
        worker ??= await Test262ExecutionWorker.start(workerNumber);
        const outcome = await worker.execute(testCase, PROBE_ENTRY);
        if (!outcome.workerReusable) worker = null;

        switch (outcome.result.kind) {
          case "passed":
            totals.passed++;
            if (outcome.result.expectation === "positive") totals.positivePassed++;
            else totals.runtimeNegativePassed++;
            break;
          case "resource-limited":
            totals.resourceLimited++;
            if (resourceLimitExamples.length < FAILURE_EXAMPLE_LIMIT) {
              resourceLimitExamples.push(
                `${testCase.path} [${testCase.mode}]: ${outcome.result.reason}`,
              );
            }
            break;
          case "compilation-failed":
            totals.compilationFailed++;
            if (compilationFailureExamples.length < FAILURE_EXAMPLE_LIMIT) {
              compilationFailureExamples.push(
                `${testCase.path} [${testCase.mode}]: ${outcome.result.reason}`,
              );
            }
            break;
          case "execution-failed":
            totals.executionFailed++;
            if (executionFailureExamples.length < FAILURE_EXAMPLE_LIMIT) {
              executionFailureExamples.push(
                `${testCase.path} [${testCase.mode}]: execution failed: ${outcome.result.reason}`,
              );
            }
            break;
        }

        completedCaseCount++;
        if (reportProgress) {
          console.error(`Test262 adapted executions ${completedCaseCount}/${cases.length}`);
        }
      }
    } finally {
      if (worker !== null) await worker.close();
    }
  });
  const workerRunResults = await Promise.allSettled(workerRuns);
  const workerRunFailure = workerRunResults.find((result) => result.status === "rejected");
  if (workerRunFailure?.status === "rejected") throw workerRunFailure.reason;

  return {
    note:
      "Each ready positive or runtime-negative mode uses one request through a pool of up to two persistent GPU compiler workers, compiles to a fresh artifact, and executes once; exact Realm and harness parity remain pending.",
    ...totals,
    resourceLimitExamples,
    compilationFailureExamples,
    executionFailureExamples,
  };
}

interface Test262WorkerExecutionOutcome {
  readonly result: Test262ExecutionCaseResult;
  readonly workerReusable: boolean;
}

async function residentSetSizeKiB(pid: number): Promise<number> {
  const measurement = await new Deno.Command("ps", {
    args: ["-o", "rss=", "-p", String(pid)],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stderr = new TextDecoder().decode(measurement.stderr).trim();
  if (!measurement.success) {
    throw new Error(`ps could not read RSS for PID ${pid}: ${stderr || "no stderr output"}`);
  }
  const rssKiB = Number(new TextDecoder().decode(measurement.stdout).trim());
  if (!Number.isFinite(rssKiB) || rssKiB < 0) {
    throw new Error(`ps returned invalid RSS for PID ${pid}: ${rssKiB}`);
  }
  return rssKiB;
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
