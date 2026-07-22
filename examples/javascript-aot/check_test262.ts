import {
  GpuFunctionalCompiler,
  requestWebGpuDevice,
  runFunctionalWasmModule,
} from "../../functional.ts";
import {
  classifyTest262CoreTest,
  parseTest262Metadata,
  type Test262ExecutionMode,
  test262ExecutionModes,
  type Test262Metadata,
} from "./src/test262.ts";
import { lowerTest262PositiveTest } from "./src/test262_harness.ts";
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

interface FrontendFailureExample {
  readonly path: string;
  readonly mode: Test262ExecutionMode;
  readonly stage: "parse" | "lower";
  readonly message: string;
}

interface ReadyTest262Case {
  readonly absolutePath: string;
  readonly path: string;
  readonly mode: Test262ExecutionMode;
  readonly metadata: Test262Metadata;
}

const suppliedCheckout = Deno.args[0];
const reportProgress = Deno.args.includes("--progress");
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

  const paths = await collectJavaScriptPaths(`${checkout}/test/language`);
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
  let parseUnsupportedCount = 0;
  let lowerUnsupportedCount = 0;
  const failureExamples: FrontendFailureExample[] = [];
  const readyExamples: string[] = [];
  const readyCases: ReadyTest262Case[] = [];
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
      if (probe.metadata.negative !== null) {
        switch (probe.metadata.negative.phase) {
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
        continue;
      }
      positiveCount++;

      let readyModeCount = 0;
      for (const outcome of probe.outcomes) {
        if (outcome.kind === "ready") {
          frontendReadyCount++;
          readyModeCount++;
          readyCases.push({
            absolutePath: probe.absolutePath,
            path: probe.path,
            mode: outcome.mode,
            metadata: probe.metadata,
          });
          if (readyExamples.length < FAILURE_EXAMPLE_LIMIT) {
            readyExamples.push(`${probe.path} [${outcome.mode}]`);
          }
          continue;
        }
        if (outcome.kind === "negative-ready") {
          throw new Error(
            `Positive Test262 test ${JSON.stringify(probe.path)} produced a negative outcome.`,
          );
        }
        const diagnostic = outcome.diagnostic;
        if (diagnostic.stage === "parse") {
          parseUnsupportedCount++;
          const token = /Unexpected token (.+?)\./.exec(diagnostic.message)?.[1] ?? "other";
          parseFailureTokens.set(token, (parseFailureTokens.get(token) ?? 0) + 1);
          if (outcome.lexeme === null) {
            throw new Error(
              `Test262 parse diagnostic ${diagnostic.code} for ${
                JSON.stringify(probe.path)
              } has no source lexeme.`,
            );
          }
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
      if (readyModeCount === probe.executionModes.length) fullyReadyFileCount++;
    }
    if (reportProgress) {
      console.error(`Test262 frontend paths ${batchEnd}/${paths.length}`);
    }
  }

  const execution = await executeReadyCases(readyCases);

  console.log(JSON.stringify(
    {
      test262Commit: actualCommit,
      scope: "test/language",
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
        negativeTestsAwaitingExactPhaseExecution: negativeParseCount + negativeResolutionCount +
          negativeRuntimeCount,
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
    },
    null,
    2,
  ));
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

async function executeReadyCases(cases: readonly ReadyTest262Case[]): Promise<{
  readonly note: string;
  readonly passed: number;
  readonly compilationFailed: number;
  readonly executionFailed: number;
  readonly failureExamples: readonly string[];
}> {
  const device = await requestWebGpuDevice();
  let passed = 0;
  let compilationFailed = 0;
  let executionFailed = 0;
  const failureExamples: string[] = [];
  try {
    const compiler = await GpuFunctionalCompiler.create(device);
    for (const testCase of cases) {
      const source = await Deno.readTextFile(testCase.absolutePath);
      const frontend = lowerTest262PositiveTest(
        testCase.path,
        source,
        testCase.metadata,
        PROBE_ENTRY,
        testCase.mode,
      );
      if (!frontend.ok) {
        throw new Error(
          `Test262 case ${JSON.stringify(testCase.path)} changed readiness before execution: ${
            frontend.diagnostics[0].message
          }`,
        );
      }
      const compilation = await compiler.compileModule(frontend.lowered.module).catch((error) => {
        throw new Error(
          `Test262 case ${
            JSON.stringify(testCase.path)
          } in ${testCase.mode} mode triggered a compiler invariant.`,
          { cause: error },
        );
      });
      if (!compilation.ok) {
        compilationFailed++;
        if (failureExamples.length < FAILURE_EXAMPLE_LIMIT) {
          failureExamples.push(
            `${testCase.path} [${testCase.mode}]: GPU compilation failed: ${
              JSON.stringify(compilation.diagnostics[0])
            }`,
          );
        }
        continue;
      }
      try {
        await runFunctionalWasmModule(compilation.module);
        passed++;
      } catch (error) {
        executionFailed++;
        if (failureExamples.length < FAILURE_EXAMPLE_LIMIT) {
          failureExamples.push(
            `${testCase.path} [${testCase.mode}]: execution failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      } finally {
        compilation.module.destroy();
      }
    }
  } finally {
    device.destroy();
  }
  return {
    note:
      "Each ready positive mode compiles to a fresh artifact and executes once; exact Realm and harness parity remain pending.",
    passed,
    compilationFailed,
    executionFailed,
    failureExamples,
  };
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
