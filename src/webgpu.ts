/**
 * The semantic kernels already bind all 8 storage buffers WebGPU guarantees by default, so any
 * additional binding needs an explicitly raised limit. Adapters report far more than this; the
 * request is clamped to whatever the selected adapter supports.
 */
const SEMANTIC_STORAGE_BUFFERS_PER_STAGE = 16;

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
        'graphics driver, compile with CpuCompiler, or select backend "cpu" on ' +
        "FunctionalCompilerService",
    );
  }

  try {
    return await adapter.requestDevice({
      requiredFeatures: adapter.features.has("timestamp-query") ? ["timestamp-query"] : [],
      requiredLimits: {
        maxStorageBuffersPerShaderStage: Math.min(
          SEMANTIC_STORAGE_BUFFERS_PER_STAGE,
          adapter.limits.maxStorageBuffersPerShaderStage,
        ),
      },
    });
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
