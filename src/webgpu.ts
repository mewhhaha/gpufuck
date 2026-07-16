/**
 * Requests the WebGPU device used for semantic compilation and evaluation.
 *
 * This throws when Deno's WebGPU API is disabled, no compatible hardware or software adapter is
 * exposed by the host, or the selected adapter cannot create a device.
 */
export async function requestWebGpuDevice(): Promise<GPUDevice> {
  const gpu = navigator.gpu;
  if (gpu === undefined) {
    throw new Error(
      'WebGPU is unavailable; add "webgpu" to deno.json\'s "unstable" array or pass ' +
        "--unstable-webgpu",
    );
  }

  let adapter: GPUAdapter | null;
  try {
    adapter = await gpu.requestAdapter();
  } catch (cause) {
    throw new Error(
      "WebGPU adapter discovery failed; check the graphics driver and WebGPU runtime setup",
      { cause },
    );
  }
  if (adapter === null) {
    throw new Error(
      "WebGPU found no compatible hardware or software adapter; install a WebGPU-capable " +
        "graphics driver or compile on another machine (there is no CPU fallback)",
    );
  }

  try {
    return await adapter.requestDevice();
  } catch (cause) {
    const adapterName = adapter.info.description || adapter.info.device || adapter.info.vendor ||
      "unnamed adapter";
    throw new Error(
      `WebGPU found adapter ${JSON.stringify(adapterName)} but could not create a device; ` +
        "inspect the attached cause for driver or device-limit details",
      { cause },
    );
  }
}
