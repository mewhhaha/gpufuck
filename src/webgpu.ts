export async function requestWebGpuDevice(): Promise<GPUDevice> {
  const gpu = navigator.gpu;
  if (gpu === undefined) {
    throw new Error(
      'WebGPU is unavailable; enable Deno\'s "webgpu" unstable feature',
    );
  }

  const adapter = await gpu.requestAdapter();
  if (adapter === null) {
    throw new Error("WebGPU could not find a compatible adapter");
  }

  try {
    return await adapter.requestDevice();
  } catch (cause) {
    throw new Error("WebGPU could not create a device from the selected adapter", { cause });
  }
}
