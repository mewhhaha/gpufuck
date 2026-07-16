import { match, rejects, strictEqual } from "node:assert/strict";

import { requestWebGpuDevice } from "../functional.ts";

const navigatorPrototype = Object.getPrototypeOf(navigator);
const navigatorGpuDescriptor = Object.getOwnPropertyDescriptor(navigatorPrototype, "gpu");
if (navigatorGpuDescriptor === undefined) {
  throw new Error("test runtime has no configurable navigator.gpu descriptor");
}
const originalNavigatorGpuDescriptor: PropertyDescriptor = navigatorGpuDescriptor;

async function withNavigatorGpu(gpu: GPU | undefined, test: () => Promise<void>): Promise<void> {
  Object.defineProperty(navigatorPrototype, "gpu", {
    configurable: true,
    enumerable: true,
    get: () => gpu,
  });
  try {
    await test();
  } finally {
    Object.defineProperty(navigatorPrototype, "gpu", originalNavigatorGpuDescriptor);
  }
}

Deno.test("missing WebGPU API explains both ways to enable it", async () => {
  await withNavigatorGpu(undefined, async () => {
    await rejects(requestWebGpuDevice, (error: Error) => {
      match(error.message, /deno\.json/);
      match(error.message, /--unstable-webgpu/);
      return true;
    });
  });
});

Deno.test("missing WebGPU adapter explains the driver requirement and absent CPU fallback", async () => {
  const gpu = {
    requestAdapter: () => Promise.resolve(null),
  } as unknown as GPU;

  await withNavigatorGpu(gpu, async () => {
    await rejects(requestWebGpuDevice, (error: Error) => {
      match(error.message, /graphics driver/);
      match(error.message, /no CPU fallback/);
      return true;
    });
  });
});

Deno.test("WebGPU adapter discovery preserves its runtime failure", async () => {
  const discoveryFailure = new Error("backend initialization failed");
  const gpu = {
    requestAdapter: () => Promise.reject(discoveryFailure),
  } as unknown as GPU;

  await withNavigatorGpu(gpu, async () => {
    await rejects(requestWebGpuDevice, (error: Error) => {
      match(error.message, /adapter discovery failed/);
      strictEqual(error.cause, discoveryFailure);
      return true;
    });
  });
});

Deno.test("WebGPU device creation identifies the adapter and preserves its failure", async () => {
  const creationFailure = new Error("device allocation failed");
  const adapter = {
    info: {
      description: "Test Adapter",
      device: "",
      vendor: "",
    },
    requestDevice: () => Promise.reject(creationFailure),
  } as unknown as GPUAdapter;
  const gpu = {
    requestAdapter: () => Promise.resolve(adapter),
  } as unknown as GPU;

  await withNavigatorGpu(gpu, async () => {
    await rejects(requestWebGpuDevice, (error: Error) => {
      match(error.message, /Test Adapter/);
      match(error.message, /device-limit details/);
      strictEqual(error.cause, creationFailure);
      return true;
    });
  });
});
