import { deepStrictEqual, equal, match, notStrictEqual, ok, rejects } from "node:assert/strict";

import { GpuLazuliCompiler, requestWebGpuDevice } from "../mod.ts";
import { LAZULI_MAXIMUM_SOURCE_BYTE_LENGTH } from "../src/lazuli/abi.ts";
import {
  GpuDispatchScheduler,
  MAXIMUM_GPU_DISPATCH_BATCH_SIZE,
} from "../src/functional/gpu_dispatch_scheduler.ts";

interface FakeCommandEncoder extends GPUCommandEncoder {
  readonly lanes: number[];
}

interface FakeCommandBuffer extends GPUCommandBuffer {
  readonly lanes: readonly number[];
}

interface SchedulerObservation {
  readonly submissions: number[][];
}

function fakeDevice(
  validation: () => Promise<GPUError | null> = () => Promise.resolve(null),
): { readonly device: GPUDevice; readonly observation: SchedulerObservation } {
  const observation: SchedulerObservation = { submissions: [] };
  const queue = {
    submit(commandBuffers: Iterable<GPUCommandBuffer>): void {
      for (const commandBuffer of commandBuffers) {
        observation.submissions.push([...(commandBuffer as FakeCommandBuffer).lanes]);
      }
    },
  };
  const device = {
    queue,
    pushErrorScope(): void {},
    popErrorScope: validation,
    createCommandEncoder(): GPUCommandEncoder {
      const lanes: number[] = [];
      return {
        lanes,
        finish: () => ({ lanes } as unknown as FakeCommandBuffer),
      } as unknown as FakeCommandEncoder;
    },
  } as unknown as GPUDevice;
  return { device, observation };
}

function recordLane(lane: number): (commands: GPUCommandEncoder) => void {
  return (commands) => (commands as FakeCommandEncoder).lanes.push(lane);
}

Deno.test("GPU dispatch scheduling coalesces lanes, skips cancellation, and bounds a flush", async () => {
  const { device, observation } = fakeDevice();
  const scheduler = new GpuDispatchScheduler(device);

  await Promise.all(
    Array.from({ length: MAXIMUM_GPU_DISPATCH_BATCH_SIZE + 1 }, (_, lane) =>
      scheduler.schedule({
        encode: recordLane(lane),
        validationContext: `dispatch lane ${lane}`,
      })),
  );
  deepStrictEqual(observation.submissions, [
    Array.from({ length: MAXIMUM_GPU_DISPATCH_BATCH_SIZE }, (_, lane) => lane),
    [MAXIMUM_GPU_DISPATCH_BATCH_SIZE],
  ]);

  const controller = new AbortController();
  const cancelled = scheduler.schedule({
    encode: recordLane(65),
    validationContext: "cancelled dispatch lane",
    signal: controller.signal,
  });
  const accepted = scheduler.schedule({
    encode: recordLane(66),
    validationContext: "accepted dispatch lane",
  });
  controller.abort(new Error("skip lane before flush"));

  await rejects(() => cancelled, /skip lane before flush/);
  await accepted;
  deepStrictEqual(observation.submissions.at(-1), [66]);
});

Deno.test("GPU dispatch scheduling isolates post-submit cancellation and reports validation", async () => {
  let resolveValidation: ((error: GPUError | null) => void) | undefined;
  const validation = new Promise<GPUError | null>((resolve) => {
    resolveValidation = resolve;
  });
  const pending = fakeDevice(() => validation);
  const scheduler = new GpuDispatchScheduler(pending.device);
  const controller = new AbortController();
  const cancelled = scheduler.schedule({
    encode: recordLane(0),
    validationContext: "cancelled dispatch lane",
    signal: controller.signal,
  });
  const accepted = scheduler.schedule({
    encode: recordLane(1),
    validationContext: "accepted dispatch lane",
  });

  while (pending.observation.submissions.length === 0) await Promise.resolve();
  controller.abort(new Error("cancel lane after submit"));
  resolveValidation?.(null);

  const [cancelledOutcome, acceptedOutcome] = await Promise.allSettled([cancelled, accepted]);
  equal(cancelledOutcome.status, "rejected");
  if (cancelledOutcome.status === "rejected") {
    match(String(cancelledOutcome.reason), /cancel lane after submit/);
  }
  equal(acceptedOutcome.status, "fulfilled");
  deepStrictEqual(pending.observation.submissions, [[0, 1]]);

  const rejected = fakeDevice(() =>
    Promise.resolve({ message: "invalid shared command buffer" } as GPUError)
  );
  const rejectingScheduler = new GpuDispatchScheduler(rejected.device);
  const outcomes = await Promise.allSettled([
    rejectingScheduler.schedule({
      encode: recordLane(2),
      validationContext: "first inference",
    }),
    rejectingScheduler.schedule({
      encode: recordLane(3),
      validationContext: "second inference",
    }),
  ]);
  equal(outcomes[0]?.status, "rejected");
  equal(outcomes[1]?.status, "rejected");
  if (outcomes[0]?.status === "rejected") {
    match(String(outcomes[0].reason), /first inference: invalid shared command buffer/);
  }
  if (outcomes[1]?.status === "rejected") {
    match(String(outcomes[1].reason), /second inference: invalid shared command buffer/);
  }
});

Deno.test("same GPU compiler batches concurrent results and remains reusable after cancellation", async () => {
  const device = await requestWebGpuDevice();
  try {
    const compiler = await GpuLazuliCompiler.create(device);
    const submit = device.queue.submit.bind(device.queue);
    const createBuffer = device.createBuffer.bind(device);
    let submissions = 0;
    let abortAfterSubmit: AbortController | undefined;
    let surfaceNodeAllocations = 0;
    const surfaceNodeAllocationsAtSubmission: number[] = [];
    Object.defineProperty(device, "createBuffer", {
      configurable: true,
      value: (descriptor: GPUBufferDescriptor) => {
        if (descriptor.label === "Lazuli surface nodes") surfaceNodeAllocations++;
        return createBuffer(descriptor);
      },
    });
    Object.defineProperty(device.queue, "submit", {
      configurable: true,
      value: (commandBuffers: GPUCommandBuffer[]) => {
        submit(commandBuffers);
        submissions++;
        surfaceNodeAllocationsAtSubmission.push(surfaceNodeAllocations);
        abortAfterSubmit?.abort(new Error("cancel one compilation after submit"));
        abortAfterSubmit = undefined;
      },
    });

    const successfulSources = Array.from(
      { length: 8 },
      (_, index) => `let identity${index} = value => value; let main = identity${index} ${index};`,
    );
    const beforeSuccess = submissions;
    const successes = await Promise.all(
      successfulSources.map((source) => compiler.compile(source)),
    );
    equal(submissions - beforeSuccess, 1);
    for (const result of successes) {
      ok(result.ok);
      if (!result.ok) continue;
      deepStrictEqual(result.module.mainType, { kind: "integer" });
    }
    if (successes[0]?.ok && successes[1]?.ok) {
      notStrictEqual(successes[0].module.nodeBuffer, successes[1].module.nodeBuffer);
    }
    for (const result of successes) if (result.ok) result.module.destroy();

    const allocationStart = surfaceNodeAllocations;
    const submissionStart = surfaceNodeAllocationsAtSubmission.length;
    const admitted = Array.from(
      { length: MAXIMUM_GPU_DISPATCH_BATCH_SIZE + 1 },
      (_, index) => compiler.compile(`let queued${index} = ${index}; let main = queued${index};`),
    );
    const queuedController = new AbortController();
    const queuedCancellation = compiler.compile("let main = 999;", {
      signal: queuedController.signal,
    });
    queuedController.abort(new Error("cancel compilation while awaiting admission"));
    const queuedCancellationAssertion = rejects(
      () => queuedCancellation,
      /cancel compilation while awaiting admission/,
    );
    const admittedResults = await Promise.all(admitted);
    await queuedCancellationAssertion;
    equal(
      surfaceNodeAllocationsAtSubmission[submissionStart],
      allocationStart + MAXIMUM_GPU_DISPATCH_BATCH_SIZE,
    );
    equal(surfaceNodeAllocations - allocationStart, MAXIMUM_GPU_DISPATCH_BATCH_SIZE + 1);
    for (const result of admittedResults) {
      ok(result.ok);
      if (result.ok) result.module.destroy();
    }

    const weightedProgram = "let main = 0;";
    const weightedSourceByteLength = LAZULI_MAXIMUM_SOURCE_BYTE_LENGTH / 4;
    const weightedSource = weightedProgram +
      " ".repeat(weightedSourceByteLength - weightedProgram.length);
    const weightedAllocationStart = surfaceNodeAllocations;
    const weightedSubmissionStart = surfaceNodeAllocationsAtSubmission.length;
    const weightedResults = await Promise.all([
      compiler.compile(weightedSource),
      compiler.compile(weightedSource),
    ]);
    equal(
      surfaceNodeAllocationsAtSubmission[weightedSubmissionStart],
      weightedAllocationStart + 1,
    );
    for (const result of weightedResults) {
      ok(result.ok);
      if (result.ok) result.module.destroy();
    }

    const mixed = await Promise.all([
      compiler.compile("let main = 42;"),
      compiler.compile("let main = absent;"),
      compiler.compile("let main : Bool = 42;"),
    ]);
    ok(mixed[0]?.ok);
    equal(mixed[1]?.ok, false);
    if (mixed[1]?.ok === false) equal(mixed[1].diagnostics[0].code, "L2001");
    equal(mixed[2]?.ok, false);
    if (mixed[2]?.ok === false) equal(mixed[2].diagnostics[0].code, "L2102");
    for (const result of mixed) if (result.ok) result.module.destroy();

    const controller = new AbortController();
    abortAfterSubmit = controller;
    const cancelled = compiler.compile("let main = 1;", { signal: controller.signal });
    const surviving = compiler.compile("let main = 2;");
    const [cancelledOutcome, survivingOutcome] = await Promise.allSettled([
      cancelled,
      surviving,
    ]);
    equal(cancelledOutcome.status, "rejected");
    if (cancelledOutcome.status === "rejected") {
      match(String(cancelledOutcome.reason), /cancel one compilation after submit/);
    }
    equal(survivingOutcome.status, "fulfilled");
    if (survivingOutcome.status === "fulfilled") {
      ok(survivingOutcome.value.ok);
      if (survivingOutcome.value.ok) survivingOutcome.value.module.destroy();
    }

    const reused = await compiler.compile("let main = 3;");
    ok(reused.ok);
    if (reused.ok) reused.module.destroy();
  } finally {
    device.destroy();
  }
});

Deno.test("packed compilation cleans up after cancellation and remains reusable", async () => {
  const device = await requestWebGpuDevice();
  try {
    const compiler = await GpuLazuliCompiler.create(device);
    const submit = device.queue.submit.bind(device.queue);
    const controller = new AbortController();
    let abortAfterSubmit = true;
    Object.defineProperty(device.queue, "submit", {
      configurable: true,
      value: (commandBuffers: GPUCommandBuffer[]) => {
        submit(commandBuffers);
        if (!abortAfterSubmit) return;
        abortAfterSubmit = false;
        controller.abort(new Error("cancel packed compilation after submit"));
      },
    });

    await rejects(
      () =>
        compiler.compileBatch([
          "let identity = value => value; let main = identity 1;",
          "let identity = value => value; let main = identity true;",
        ], {
          maximumStepsPerDispatch: 1,
          signal: controller.signal,
        }),
      /cancel packed compilation after submit/,
    );

    const reused = await compiler.compileBatch(["let main = 2;", "let main = 3;"]);
    ok(reused.every((result) => result.ok));
    for (const result of reused) if (result.ok) result.module.destroy();
  } finally {
    device.destroy();
  }
});
