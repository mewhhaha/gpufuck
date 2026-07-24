import {
  buildFunctionalSurfaceModule,
  GpuFunctionalCompiler,
  requestWebGpuDevice,
  surface,
} from "../../../functional.ts";
import {
  executeTest262Case,
  TEST262_COMPILATION_OPTIONS,
  type Test262ExecutionResponse,
} from "./test262_execute.ts";
import {
  encodeTest262WorkerMessage,
  parseTest262WorkerRequest,
  readNdjsonLines,
} from "./test262_worker_protocol.ts";

const device = await requestWebGpuDevice();
try {
  const compiler = await GpuFunctionalCompiler.create(device);
  const warmupModule = buildFunctionalSurfaceModule(
    [{
      name: "__test262_worker_warmup",
      parameters: [],
      annotation: null,
      body: surface.boolean(true),
    }],
    [],
    "__test262_worker_warmup",
    0,
  );
  const warmupCompilation = await compiler.compileModule(
    warmupModule,
    TEST262_COMPILATION_OPTIONS,
  );
  if (!warmupCompilation.ok) {
    throw new Error(
      `Test262 execution worker warmup compilation failed: ${
        JSON.stringify(warmupCompilation.diagnostics[0])
      }`,
    );
  }
  warmupCompilation.module.destroy();

  const writer = Deno.stdout.writable.getWriter();
  try {
    await writer.write(encodeTest262WorkerMessage({ type: "ready" }));
    for await (const line of readNdjsonLines(Deno.stdin.readable)) {
      const workerRequest = parseTest262WorkerRequest(line);
      if (workerRequest.type === "close") break;

      let response: Test262ExecutionResponse;
      try {
        response = {
          ok: true,
          result: await executeTest262Case(compiler, workerRequest.request),
        };
      } catch (error) {
        response = {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack ?? null : null,
        };
      }
      await writer.write(encodeTest262WorkerMessage({
        type: "result",
        requestId: workerRequest.requestId,
        response,
      }));
    }
  } finally {
    writer.releaseLock();
  }
} finally {
  device.destroy();
}
