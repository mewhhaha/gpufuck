import {
  encodeWasmModuleWithEncodedFunctionBodies,
  type WasmModuleEncoding,
} from "./wasm_binary.ts";

const WORKGROUP_SIZE = 256;
const MAXIMUM_FUNCTION_COUNT = WORKGROUP_SIZE * WORKGROUP_SIZE;
const DESCRIPTOR_WORD_LENGTH = 4;
const PLACEMENT_WORD_LENGTH = 2;

export interface GpuWasmEncodingResult {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly functionCount: number;
  readonly functionBodyBytes: number;
  readonly milliseconds: number;
}

export class GpuWasmEncoder {
  readonly #device: GPUDevice;
  readonly #bindGroupLayout: GPUBindGroupLayout;
  readonly #sizePipeline: GPUComputePipeline;
  readonly #bodyScanPipeline: GPUComputePipeline;
  readonly #blockScanPipeline: GPUComputePipeline;
  readonly #blockOffsetPipeline: GPUComputePipeline;
  readonly #writePipeline: GPUComputePipeline;

  private constructor(
    device: GPUDevice,
    bindGroupLayout: GPUBindGroupLayout,
    pipelines: readonly [
      GPUComputePipeline,
      GPUComputePipeline,
      GPUComputePipeline,
      GPUComputePipeline,
      GPUComputePipeline,
    ],
  ) {
    this.#device = device;
    this.#bindGroupLayout = bindGroupLayout;
    [
      this.#sizePipeline,
      this.#bodyScanPipeline,
      this.#blockScanPipeline,
      this.#blockOffsetPipeline,
      this.#writePipeline,
    ] = pipelines;
  }

  static async create(device: GPUDevice): Promise<GpuWasmEncoder> {
    if (device.limits.maxStorageBuffersPerShaderStage < 7) {
      throw new Error(
        `segmented WebAssembly emission needs 7 storage bindings but the device permits ${device.limits.maxStorageBuffersPerShaderStage}`,
      );
    }
    const shader = device.createShaderModule({
      label: "Segmented WebAssembly function-body emission",
      code: GPU_WASM_ENCODER_SHADER,
    });
    const compilation = await shader.getCompilationInfo();
    const errors = compilation.messages.filter((message) => message.type === "error");
    if (errors.length !== 0) {
      throw new Error(
        `WebGPU rejected the segmented WebAssembly emission shader:\n${
          errors.map((error) => `${error.lineNum}:${error.linePos}: ${error.message}`).join("\n")
        }`,
      );
    }
    const bindGroupLayout = device.createBindGroupLayout({
      label: "Segmented WebAssembly emission bindings",
      entries: [
        storageBinding(0, true),
        storageBinding(1, true),
        storageBinding(2, true),
        storageBinding(3, false),
        storageBinding(4, false),
        storageBinding(5, false),
        storageBinding(6, false),
      ],
    });
    const layout = device.createPipelineLayout({
      label: "Segmented WebAssembly emission layout",
      bindGroupLayouts: [bindGroupLayout],
    });
    try {
      const pipeline = async (entryPoint: string): Promise<GPUComputePipeline> =>
        await device.createComputePipelineAsync({
          label: `Segmented WebAssembly ${entryPoint}`,
          layout,
          compute: { module: shader, entryPoint },
        });
      const pipelines = await Promise.all([
        pipeline("size_bodies"),
        pipeline("scan_bodies"),
        pipeline("scan_blocks"),
        pipeline("add_block_offsets"),
        pipeline("write_bodies"),
      ]);
      return new GpuWasmEncoder(device, bindGroupLayout, pipelines);
    } catch (cause) {
      throw new Error("WebGPU could not create the segmented WebAssembly emission pipelines", {
        cause,
      });
    }
  }

  async encode(encoding: WasmModuleEncoding): Promise<GpuWasmEncodingResult> {
    const input = flattenFunctionBodies(encoding);
    const functionCount = encoding.functions.length;
    if (functionCount === 0) {
      const functionBodies = new Uint8Array(0);
      return {
        bytes: encodeWasmModuleWithEncodedFunctionBodies(encoding, functionBodies),
        functionCount,
        functionBodyBytes: 0,
        milliseconds: 0,
      };
    }
    if (functionCount > MAXIMUM_FUNCTION_COUNT) {
      throw new RangeError(
        `segmented WebAssembly emission supports at most ${MAXIMUM_FUNCTION_COUNT} functions; received ${functionCount}`,
      );
    }
    const blockCount = Math.ceil(functionCount / WORKGROUP_SIZE);
    if (blockCount > this.#device.limits.maxComputeWorkgroupsPerDimension) {
      throw new RangeError(
        `segmented WebAssembly emission needs ${blockCount} workgroups but the device permits ${this.#device.limits.maxComputeWorkgroupsPerDimension}`,
      );
    }
    validateStorageByteLength(this.#device, "function descriptors", input.descriptors.byteLength);
    validateStorageByteLength(this.#device, "local types", input.localTypes.byteLength);
    validateStorageByteLength(this.#device, "instructions", input.instructions.byteLength);
    const placementsByteLength = functionCount * PLACEMENT_WORD_LENGTH *
      Uint32Array.BYTES_PER_ELEMENT;
    const blocksByteLength = blockCount * PLACEMENT_WORD_LENGTH * Uint32Array.BYTES_PER_ELEMENT;
    const outputByteLength = input.outputCapacity * Uint32Array.BYTES_PER_ELEMENT;
    validateStorageByteLength(this.#device, "body placements", placementsByteLength);
    validateStorageByteLength(this.#device, "block placements", blocksByteLength);
    validateStorageByteLength(this.#device, "function body output", outputByteLength);
    const readbackByteLength = Uint32Array.BYTES_PER_ELEMENT + outputByteLength;
    if (readbackByteLength > this.#device.limits.maxBufferSize) {
      throw new RangeError(
        `segmented WebAssembly readback needs ${readbackByteLength} bytes but the device permits ${this.#device.limits.maxBufferSize}`,
      );
    }

    const buffers: GPUBuffer[] = [];
    let readback: GPUBuffer | undefined;
    let mapped = false;
    const started = performance.now();
    this.#device.pushErrorScope("validation");
    this.#device.pushErrorScope("out-of-memory");
    let setupCause: unknown;
    try {
      const descriptors = uploadStorageBuffer(
        this.#device,
        "WebAssembly function descriptors",
        input.descriptors,
      );
      const localTypes = uploadStorageBuffer(
        this.#device,
        "WebAssembly local types",
        input.localTypes,
      );
      const instructions = uploadStorageBuffer(
        this.#device,
        "WebAssembly instructions",
        input.instructions,
      );
      const placements = storageBuffer(
        this.#device,
        "WebAssembly body placements",
        placementsByteLength,
      );
      const blocks = storageBuffer(
        this.#device,
        "WebAssembly block placements",
        blocksByteLength,
      );
      const output = storageBuffer(
        this.#device,
        "WebAssembly encoded function bodies",
        outputByteLength,
        GPUBufferUsage.COPY_SRC,
      );
      const state = storageBuffer(
        this.#device,
        "WebAssembly emission state",
        Uint32Array.BYTES_PER_ELEMENT,
        GPUBufferUsage.COPY_SRC,
      );
      buffers.push(descriptors, localTypes, instructions, placements, blocks, output, state);
      readback = this.#device.createBuffer({
        label: "WebAssembly function-body readback",
        size: readbackByteLength,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      buffers.push(readback);
      const bindings = this.#device.createBindGroup({
        label: "Segmented WebAssembly emission bindings",
        layout: this.#bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: descriptors } },
          { binding: 1, resource: { buffer: localTypes } },
          { binding: 2, resource: { buffer: instructions } },
          { binding: 3, resource: { buffer: placements } },
          { binding: 4, resource: { buffer: blocks } },
          { binding: 5, resource: { buffer: output } },
          { binding: 6, resource: { buffer: state } },
        ],
      });
      const commands = this.#device.createCommandEncoder({
        label: "Segmented WebAssembly emission commands",
      });
      this.#dispatch(commands, bindings, this.#sizePipeline, blockCount, "size function bodies");
      this.#dispatch(commands, bindings, this.#bodyScanPipeline, blockCount, "scan body sizes");
      this.#dispatch(commands, bindings, this.#blockScanPipeline, 1, "scan body blocks");
      this.#dispatch(
        commands,
        bindings,
        this.#blockOffsetPipeline,
        blockCount,
        "add body block offsets",
      );
      this.#dispatch(commands, bindings, this.#writePipeline, blockCount, "write function bodies");
      commands.copyBufferToBuffer(state, 0, readback, 0, Uint32Array.BYTES_PER_ELEMENT);
      commands.copyBufferToBuffer(
        output,
        0,
        readback,
        Uint32Array.BYTES_PER_ELEMENT,
        outputByteLength,
      );
      this.#device.queue.submit([commands.finish()]);
    } catch (cause) {
      setupCause = cause;
    }
    const [outOfMemory, validation] = await Promise.all([
      this.#device.popErrorScope(),
      this.#device.popErrorScope(),
    ]);
    if (validation !== null || outOfMemory !== null || setupCause !== undefined) {
      for (const buffer of buffers) buffer.destroy();
      const evidence = validation?.message ?? outOfMemory?.message ?? String(setupCause);
      throw new Error(
        `WebGPU could not emit ${functionCount} WebAssembly function bodies: ${evidence}`,
        setupCause === undefined ? undefined : { cause: setupCause },
      );
    }
    if (readback === undefined) {
      for (const buffer of buffers) buffer.destroy();
      throw new Error("WebGPU omitted the WebAssembly function-body readback buffer");
    }
    try {
      await readback.mapAsync(GPUMapMode.READ);
      mapped = true;
      const words = new Uint32Array(readback.getMappedRange());
      const functionBodyBytes = words[0];
      if (functionBodyBytes === undefined || functionBodyBytes > input.outputCapacity) {
        throw new Error(
          `segmented WebAssembly emission returned ${functionBodyBytes} bytes for ${input.outputCapacity} bytes of output capacity`,
        );
      }
      const encodedFunctionBodies = new Uint8Array(functionBodyBytes);
      for (let index = 0; index < functionBodyBytes; index++) {
        const byte = words[index + 1];
        if (byte === undefined || byte > 0xff) {
          throw new Error(
            `segmented WebAssembly emission returned byte ${byte} at function-body offset ${index}`,
          );
        }
        encodedFunctionBodies[index] = byte;
      }
      return {
        bytes: encodeWasmModuleWithEncodedFunctionBodies(encoding, encodedFunctionBodies),
        functionCount,
        functionBodyBytes,
        milliseconds: performance.now() - started,
      };
    } finally {
      if (mapped) readback.unmap();
      for (const buffer of buffers) buffer.destroy();
    }
  }

  #dispatch(
    commands: GPUCommandEncoder,
    bindings: GPUBindGroup,
    pipeline: GPUComputePipeline,
    workgroups: number,
    label: string,
  ): void {
    const pass = commands.beginComputePass({ label });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings);
    pass.dispatchWorkgroups(workgroups);
    pass.end();
  }
}

interface FlattenedFunctionBodies {
  readonly descriptors: Uint32Array<ArrayBuffer>;
  readonly localTypes: Uint32Array<ArrayBuffer>;
  readonly instructions: Uint32Array<ArrayBuffer>;
  readonly outputCapacity: number;
}

function flattenFunctionBodies(encoding: WasmModuleEncoding): FlattenedFunctionBodies {
  const localCount = encoding.functions.reduce((total, body) => total + body.localTypes.length, 0);
  const instructionCount = encoding.functions.reduce(
    (total, body) => total + body.instructions.length,
    0,
  );
  const outputCapacity = instructionCount + localCount * 6 + encoding.functions.length * 11;
  if (!Number.isSafeInteger(outputCapacity) || outputCapacity > 0xffff_ffff) {
    throw new RangeError(
      `segmented WebAssembly function bodies exceed the 32-bit output address space: ${outputCapacity} bytes`,
    );
  }
  const descriptors = new Uint32Array(encoding.functions.length * DESCRIPTOR_WORD_LENGTH);
  const localTypes = new Uint32Array(localCount);
  const instructions = new Uint32Array(instructionCount);
  let localOffset = 0;
  let instructionOffset = 0;
  for (const [functionIndex, body] of encoding.functions.entries()) {
    const descriptor = functionIndex * DESCRIPTOR_WORD_LENGTH;
    descriptors[descriptor] = localOffset;
    descriptors[descriptor + 1] = body.localTypes.length;
    descriptors[descriptor + 2] = instructionOffset;
    descriptors[descriptor + 3] = body.instructions.length;
    for (const type of body.localTypes) {
      if (!Number.isInteger(type) || type < 0 || type > 0xff) {
        throw new RangeError(
          `WebAssembly function ${functionIndex} contains local type byte ${type}`,
        );
      }
      localTypes[localOffset++] = type;
    }
    for (const instruction of body.instructions) {
      if (!Number.isInteger(instruction) || instruction < 0 || instruction > 0xff) {
        throw new RangeError(
          `WebAssembly function ${functionIndex} contains instruction byte ${instruction}`,
        );
      }
      instructions[instructionOffset++] = instruction;
    }
  }
  return { descriptors, localTypes, instructions, outputCapacity };
}

function storageBinding(binding: number, readOnly: boolean): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility: GPUShaderStage.COMPUTE,
    buffer: { type: readOnly ? "read-only-storage" : "storage" },
  };
}

function uploadStorageBuffer(
  device: GPUDevice,
  label: string,
  words: Uint32Array<ArrayBuffer>,
): GPUBuffer {
  const buffer = device.createBuffer({
    label,
    size: Math.max(Uint32Array.BYTES_PER_ELEMENT, words.byteLength),
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
  });
  if (words.byteLength !== 0) device.queue.writeBuffer(buffer, 0, words);
  return buffer;
}

function storageBuffer(
  device: GPUDevice,
  label: string,
  byteLength: number,
  additionalUsage = 0,
): GPUBuffer {
  return device.createBuffer({
    label,
    size: Math.max(Uint32Array.BYTES_PER_ELEMENT, byteLength),
    usage: GPUBufferUsage.STORAGE | additionalUsage,
  });
}

function validateStorageByteLength(device: GPUDevice, name: string, byteLength: number): void {
  const allocatedByteLength = Math.max(Uint32Array.BYTES_PER_ELEMENT, byteLength);
  if (allocatedByteLength > device.limits.maxStorageBufferBindingSize) {
    throw new RangeError(
      `segmented WebAssembly ${name} need ${allocatedByteLength} bytes but the device permits ${device.limits.maxStorageBufferBindingSize} per storage binding`,
    );
  }
  if (allocatedByteLength > device.limits.maxBufferSize) {
    throw new RangeError(
      `segmented WebAssembly ${name} need ${allocatedByteLength} bytes but the device permits ${device.limits.maxBufferSize} per buffer`,
    );
  }
}

const GPU_WASM_ENCODER_SHADER = /* wgsl */ `
const WORKGROUP_SIZE: u32 = ${WORKGROUP_SIZE}u;

struct FunctionDescriptor {
  local_start: u32,
  local_count: u32,
  instruction_start: u32,
  instruction_count: u32,
}

struct Placement {
  size: u32,
  offset: u32,
}

@group(0) @binding(0)
var<storage, read> descriptors: array<FunctionDescriptor>;
@group(0) @binding(1)
var<storage, read> local_types: array<u32>;
@group(0) @binding(2)
var<storage, read> instructions: array<u32>;
@group(0) @binding(3)
var<storage, read_write> placements: array<Placement>;
@group(0) @binding(4)
var<storage, read_write> blocks: array<Placement>;
@group(0) @binding(5)
var<storage, read_write> function_bodies: array<u32>;
@group(0) @binding(6)
var<storage, read_write> emission_state: array<u32>;

var<workgroup> scan_values: array<u32, ${WORKGROUP_SIZE}>;

fn unsigned_size(value: u32) -> u32 {
  var remaining = value;
  var size = 1u;
  while remaining >= 128u {
    remaining = remaining >> 7u;
    size += 1u;
  }
  return size;
}

fn local_encoding_size(descriptor: FunctionDescriptor) -> vec2<u32> {
  var group_count = 0u;
  var group_bytes = 0u;
  var local = 0u;
  while local < descriptor.local_count {
    let type_ = local_types[descriptor.local_start + local];
    var run_length = 1u;
    while local + run_length < descriptor.local_count &&
        local_types[descriptor.local_start + local + run_length] == type_ {
      run_length += 1u;
    }
    group_count += 1u;
    group_bytes += unsigned_size(run_length) + 1u;
    local += run_length;
  }
  return vec2(group_count, unsigned_size(group_count) + group_bytes);
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn size_bodies(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let function_index = invocation.x;
  if function_index >= arrayLength(&descriptors) {
    return;
  }
  let descriptor = descriptors[function_index];
  let local_encoding = local_encoding_size(descriptor);
  let content_size = local_encoding.y + descriptor.instruction_count + 1u;
  placements[function_index].size = unsigned_size(content_size) + content_size;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn scan_bodies(
  @builtin(local_invocation_id) local_invocation: vec3<u32>,
  @builtin(global_invocation_id) global_invocation: vec3<u32>,
  @builtin(workgroup_id) workgroup: vec3<u32>,
) {
  let lane = local_invocation.x;
  let function_index = global_invocation.x;
  let function_count = arrayLength(&descriptors);
  var size = 0u;
  if function_index < function_count {
    size = placements[function_index].size;
  }
  scan_values[lane] = size;
  workgroupBarrier();
  var distance = 1u;
  while distance < WORKGROUP_SIZE {
    var previous = 0u;
    if lane >= distance {
      previous = scan_values[lane - distance];
    }
    workgroupBarrier();
    if lane >= distance {
      scan_values[lane] += previous;
    }
    workgroupBarrier();
    distance = distance << 1u;
  }
  if function_index < function_count {
    placements[function_index].offset = scan_values[lane] - size;
  }
  if lane == WORKGROUP_SIZE - 1u {
    blocks[workgroup.x].size = scan_values[lane];
  }
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn scan_blocks(@builtin(local_invocation_id) local_invocation: vec3<u32>) {
  let lane = local_invocation.x;
  let block_count = arrayLength(&blocks);
  var size = 0u;
  if lane < block_count {
    size = blocks[lane].size;
  }
  scan_values[lane] = size;
  workgroupBarrier();
  var distance = 1u;
  while distance < WORKGROUP_SIZE {
    var previous = 0u;
    if lane >= distance {
      previous = scan_values[lane - distance];
    }
    workgroupBarrier();
    if lane >= distance {
      scan_values[lane] += previous;
    }
    workgroupBarrier();
    distance = distance << 1u;
  }
  if lane < block_count {
    blocks[lane].offset = scan_values[lane] - size;
  }
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn add_block_offsets(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let function_index = invocation.x;
  let function_count = arrayLength(&descriptors);
  if function_index >= function_count {
    return;
  }
  let block = function_index / WORKGROUP_SIZE;
  placements[function_index].offset += blocks[block].offset;
  if function_index + 1u == function_count {
    emission_state[0] = placements[function_index].offset + placements[function_index].size;
  }
}

fn write_unsigned(start: u32, value: u32) -> u32 {
  var offset = start;
  var remaining = value;
  loop {
    let byte = remaining & 0x7fu;
    remaining = remaining >> 7u;
    function_bodies[offset] = select(byte | 0x80u, byte, remaining == 0u);
    offset += 1u;
    if remaining == 0u {
      break;
    }
  }
  return offset;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn write_bodies(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let function_index = invocation.x;
  if function_index >= arrayLength(&descriptors) {
    return;
  }
  let descriptor = descriptors[function_index];
  let local_encoding = local_encoding_size(descriptor);
  let content_size = local_encoding.y + descriptor.instruction_count + 1u;
  var output_offset = write_unsigned(placements[function_index].offset, content_size);
  output_offset = write_unsigned(output_offset, local_encoding.x);
  var local = 0u;
  while local < descriptor.local_count {
    let type_ = local_types[descriptor.local_start + local];
    var run_length = 1u;
    while local + run_length < descriptor.local_count &&
        local_types[descriptor.local_start + local + run_length] == type_ {
      run_length += 1u;
    }
    output_offset = write_unsigned(output_offset, run_length);
    function_bodies[output_offset] = type_;
    output_offset += 1u;
    local += run_length;
  }
  for (var instruction = 0u; instruction < descriptor.instruction_count; instruction += 1u) {
    function_bodies[output_offset + instruction] =
      instructions[descriptor.instruction_start + instruction];
  }
  output_offset += descriptor.instruction_count;
  function_bodies[output_offset] = 0x0bu;
}
`;
