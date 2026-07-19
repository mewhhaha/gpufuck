import { LAZULI_NO_INDEX, LazuliCoreTag } from "./abi.ts";
import type { LazuliCoreNode } from "./compiler_module.ts";

const NO_WAVE = 0xffff_ffff;
const GPU_UNSCHEDULED_WAVE = 0;
const WORKGROUP_SIZE = 64;
const MAXIMUM_GRAPH_COMPONENTS = 256;
const MAXIMUM_GRAPH_EDGES = 256;
const GRAPH_DESCRIPTOR_WORDS = 2;

export interface SemanticDefinitionComponent {
  readonly definitions: readonly number[];
  readonly dependencies: readonly number[];
}

export interface SemanticDefinitionDependencyGraph {
  readonly definitionCount: number;
  readonly components: readonly SemanticDefinitionComponent[];
  readonly componentByDefinition: readonly number[];
}

export interface SemanticDefinitionWavefrontSchedule {
  readonly componentWaves: readonly number[];
  readonly wavefronts: readonly (readonly number[])[];
}

export function semanticDefinitionDependencyGraph(
  definitionRoots: readonly number[],
  nodes: readonly LazuliCoreNode[],
): SemanticDefinitionDependencyGraph {
  const dependencies = definitionRoots.map((root, definition) =>
    definitionDependencies(definition, root, definitionRoots.length, nodes)
  );
  return dependencyGraph(dependencies);
}

export function scheduleSemanticDefinitionWavefronts(
  graph: SemanticDefinitionDependencyGraph,
): SemanticDefinitionWavefrontSchedule {
  const dependencyCounts = graph.components.map((component) => component.dependencies.length);
  const dependents = graph.components.map(() => [] as number[]);
  for (const [componentIndex, component] of graph.components.entries()) {
    for (const dependency of component.dependencies) dependents[dependency]!.push(componentIndex);
  }
  const componentWaves = Array.from({ length: graph.components.length }, () => NO_WAVE);
  let frontier = dependencyCounts.flatMap((count, component) => count === 0 ? [component] : []);
  let wave = 0;
  while (frontier.length !== 0) {
    const next: number[] = [];
    for (const component of frontier) {
      componentWaves[component] = wave;
      for (const dependent of dependents[component]!) {
        dependencyCounts[dependent]!--;
        if (dependencyCounts[dependent] === 0) next.push(dependent);
      }
    }
    frontier = next;
    wave += 1;
  }
  const incomplete = componentWaves.findIndex((componentWave) => componentWave === NO_WAVE);
  if (incomplete !== -1) {
    throw new Error(
      `semantic definition component ${incomplete} remains cyclic after SCC planning`,
    );
  }
  return wavefrontSchedule(componentWaves);
}

export class GpuSemanticDefinitionWavefrontPrototype {
  readonly #device: GPUDevice;
  readonly #schedule: GPUComputePipeline;
  readonly #bindings: GPUBindGroupLayout;

  private constructor(
    device: GPUDevice,
    schedule: GPUComputePipeline,
    bindings: GPUBindGroupLayout,
  ) {
    this.#device = device;
    this.#schedule = schedule;
    this.#bindings = bindings;
  }

  static async create(device: GPUDevice): Promise<GpuSemanticDefinitionWavefrontPrototype> {
    const shader = device.createShaderModule({
      label: "semantic definition wavefront prototype",
      code: SEMANTIC_DEFINITION_WAVEFRONT_SHADER,
    });
    const diagnostics = await shader.getCompilationInfo();
    const errors = diagnostics.messages.filter((message) => message.type === "error");
    if (errors.length !== 0) {
      throw new Error(
        `WebGPU rejected the semantic definition wavefront prototype:\n${
          errors.map((error) => `${error.lineNum}:${error.linePos}: ${error.message}`).join("\n")
        }`,
      );
    }
    const bindings = device.createBindGroupLayout({
      label: "semantic definition wavefront bindings",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      ],
    });
    const layout = device.createPipelineLayout({
      label: "semantic definition wavefront pipeline layout",
      bindGroupLayouts: [bindings],
    });
    const descriptor: GPUComputePipelineDescriptor = {
      label: "semantic definition wavefront schedule",
      layout,
      compute: { module: shader, entryPoint: "schedule_wavefronts" },
    };
    const schedule = await device.createComputePipelineAsync(descriptor);
    return new GpuSemanticDefinitionWavefrontPrototype(device, schedule, bindings);
  }

  async schedule(
    graph: SemanticDefinitionDependencyGraph,
  ): Promise<SemanticDefinitionWavefrontSchedule> {
    const schedules = await this.scheduleBatch([graph]);
    return schedules[0]!;
  }

  async scheduleBatch(
    graphs: readonly SemanticDefinitionDependencyGraph[],
  ): Promise<readonly SemanticDefinitionWavefrontSchedule[]> {
    if (graphs.length === 0) return [];
    const plan = this.prepareBatch(graphs);
    try {
      return await plan.scheduleAndReadback();
    } finally {
      plan.destroy();
    }
  }

  prepareBatch(
    graphs: readonly SemanticDefinitionDependencyGraph[],
  ): GpuSemanticDefinitionWavefrontPlan {
    if (graphs.length === 0) {
      throw new Error("GPU semantic wavefront plans require at least one dependency graph");
    }
    const workgroups = Math.ceil(graphs.length / WORKGROUP_SIZE);
    if (workgroups > this.#device.limits.maxComputeWorkgroupsPerDimension) {
      throw new Error(
        `GPU semantic wavefront batch needs ${workgroups} workgroups for ${graphs.length} graphs but the device permits ${this.#device.limits.maxComputeWorkgroupsPerDimension} workgroups per dispatch`,
      );
    }
    return GpuSemanticDefinitionWavefrontPlan.create(
      this.#device,
      this.#schedule,
      this.#bindings,
      graphs,
      workgroups,
    );
  }
}

export class GpuSemanticDefinitionWavefrontPlan {
  readonly componentWavesBuffer: GPUBuffer;
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;
  readonly #bindGroup: GPUBindGroup;
  readonly #initialDependencyCounts: GPUBuffer;
  readonly #dependencyCounts: GPUBuffer;
  readonly #componentOffsets: Uint32Array;
  readonly #componentCounts: Uint32Array;
  readonly #workgroups: number;
  readonly #buffers: GPUBuffer[];
  #destroyed = false;

  private constructor(
    device: GPUDevice,
    pipeline: GPUComputePipeline,
    bindGroup: GPUBindGroup,
    initialDependencyCounts: GPUBuffer,
    dependencyCounts: GPUBuffer,
    componentWavesBuffer: GPUBuffer,
    componentOffsets: Uint32Array,
    componentCounts: Uint32Array,
    workgroups: number,
    buffers: GPUBuffer[],
  ) {
    this.#device = device;
    this.#pipeline = pipeline;
    this.#bindGroup = bindGroup;
    this.#initialDependencyCounts = initialDependencyCounts;
    this.#dependencyCounts = dependencyCounts;
    this.componentWavesBuffer = componentWavesBuffer;
    this.#componentOffsets = componentOffsets;
    this.#componentCounts = componentCounts;
    this.#workgroups = workgroups;
    this.#buffers = buffers;
  }

  static create(
    device: GPUDevice,
    pipeline: GPUComputePipeline,
    bindings: GPUBindGroupLayout,
    graphs: readonly SemanticDefinitionDependencyGraph[],
    workgroups: number,
  ): GpuSemanticDefinitionWavefrontPlan {
    const packed = packComponentGraphBatch(graphs);
    const buffers: GPUBuffer[] = [];
    const initialDependencyCounts = storageBuffer(
      device,
      "semantic wavefront initial dependency counts",
      packed.dependencyCounts,
      buffers,
      GPUBufferUsage.COPY_SRC,
    );
    const dependencyCounts = storageBuffer(
      device,
      "semantic wavefront dependency counts",
      new Uint32Array(packed.dependencyCounts.length),
      buffers,
    );
    const dependentOffsets = storageBuffer(
      device,
      "semantic wavefront dependent offsets",
      packed.dependentOffsets,
      buffers,
    );
    const dependents = storageBuffer(
      device,
      "semantic wavefront dependents",
      packed.dependents,
      buffers,
    );
    const componentWaves = storageBuffer(
      device,
      "semantic wavefront results",
      new Uint32Array(Math.max(1, packed.componentCount)),
      buffers,
      GPUBufferUsage.COPY_SRC,
    );
    const graphDescriptors = storageBuffer(
      device,
      "semantic wavefront graph descriptors",
      packed.graphDescriptors,
      buffers,
    );
    const bindGroup = device.createBindGroup({
      layout: bindings,
      entries: [dependencyCounts, dependentOffsets, dependents, componentWaves, graphDescriptors]
        .map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    return new GpuSemanticDefinitionWavefrontPlan(
      device,
      pipeline,
      bindGroup,
      initialDependencyCounts,
      dependencyCounts,
      componentWaves,
      packed.componentOffsets,
      Uint32Array.from(graphs, (graph) => graph.components.length),
      workgroups,
      buffers,
    );
  }

  encodeSchedule(commands: GPUCommandEncoder): void {
    this.#requireActive();
    commands.copyBufferToBuffer(
      this.#initialDependencyCounts,
      0,
      this.#dependencyCounts,
      0,
      this.#initialDependencyCounts.size,
    );
    commands.clearBuffer(this.componentWavesBuffer);
    dispatch(commands, this.#pipeline, this.#bindGroup, this.#workgroups);
  }

  async execute(repetitions = 1): Promise<void> {
    this.#requireActive();
    if (!Number.isInteger(repetitions) || repetitions < 1) {
      throw new Error(
        `GPU semantic wavefront execution repetitions must be a positive integer, received ${repetitions}`,
      );
    }
    const commands = this.#device.createCommandEncoder({
      label: repetitions === 1
        ? "semantic definition wavefront schedule"
        : `semantic definition wavefront schedule (${repetitions} repetitions)`,
    });
    for (let repetition = 0; repetition < repetitions; repetition++) {
      this.encodeSchedule(commands);
    }
    this.#device.queue.submit([commands.finish()]);
    await this.#device.queue.onSubmittedWorkDone();
  }

  async scheduleAndReadback(): Promise<readonly SemanticDefinitionWavefrontSchedule[]> {
    this.#requireActive();
    const readback = this.#device.createBuffer({
      label: "semantic wavefront readback",
      size: this.componentWavesBuffer.size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      const commands = this.#device.createCommandEncoder({
        label: "semantic definition wavefront schedule and readback",
      });
      this.encodeSchedule(commands);
      commands.copyBufferToBuffer(
        this.componentWavesBuffer,
        0,
        readback,
        0,
        this.componentWavesBuffer.size,
      );
      this.#device.queue.submit([commands.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const encodedWaves = new Uint32Array(readback.getMappedRange().slice(0));
      readback.unmap();
      return this.#decodeSchedules(encodedWaves);
    } finally {
      readback.destroy();
    }
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const buffer of this.#buffers) buffer.destroy();
  }

  #decodeSchedules(encodedWaves: Uint32Array): readonly SemanticDefinitionWavefrontSchedule[] {
    const schedules: SemanticDefinitionWavefrontSchedule[] = [];
    for (let graph = 0; graph < this.#componentCounts.length; graph++) {
      const start = this.#componentOffsets[graph]!;
      const end = start + this.#componentCounts[graph]!;
      const graphWaves = [...encodedWaves.subarray(start, end)].map((wave) =>
        wave === GPU_UNSCHEDULED_WAVE ? NO_WAVE : wave - 1
      );
      const incomplete = graphWaves.findIndex((wave) => wave === NO_WAVE);
      if (incomplete !== -1) {
        throw new Error(
          `GPU semantic wavefront graph ${graph} did not schedule component ${incomplete} of ${graphWaves.length}`,
        );
      }
      schedules.push(wavefrontSchedule(graphWaves));
    }
    return schedules;
  }

  #requireActive(): void {
    if (!this.#destroyed) return;
    throw new Error("GPU semantic wavefront plan cannot be used after destroy()");
  }
}

function dependencyGraph(
  dependencies: readonly (readonly number[])[],
): SemanticDefinitionDependencyGraph {
  const reverse = dependencies.map(() => [] as number[]);
  for (const [definition, required] of dependencies.entries()) {
    for (const dependency of required) reverse[dependency]!.push(definition);
  }
  const finished: number[] = [];
  const visited = new Set<number>();
  for (let definition = 0; definition < dependencies.length; definition++) {
    if (visited.has(definition)) continue;
    const stack: { readonly definition: number; nextDependency: number }[] = [{
      definition,
      nextDependency: 0,
    }];
    visited.add(definition);
    while (stack.length !== 0) {
      const frame = stack.at(-1)!;
      const dependency = dependencies[frame.definition]![frame.nextDependency];
      if (dependency !== undefined) {
        frame.nextDependency += 1;
        if (visited.has(dependency)) continue;
        visited.add(dependency);
        stack.push({ definition: dependency, nextDependency: 0 });
        continue;
      }
      finished.push(frame.definition);
      stack.pop();
    }
  }
  const componentByDefinition = Array.from({ length: dependencies.length }, () => -1);
  const members: number[][] = [];
  for (let index = finished.length - 1; index >= 0; index--) {
    const root = finished[index]!;
    if (componentByDefinition[root] !== -1) continue;
    const component = members.length;
    const componentMembers: number[] = [];
    const pending = [root];
    componentByDefinition[root] = component;
    while (pending.length !== 0) {
      const definition = pending.pop()!;
      componentMembers.push(definition);
      for (const dependent of reverse[definition]!) {
        if (componentByDefinition[dependent] !== -1) continue;
        componentByDefinition[dependent] = component;
        pending.push(dependent);
      }
    }
    componentMembers.sort((left, right) => left - right);
    members.push(componentMembers);
  }
  const components = members.map((definitions, component) => {
    const componentDependencies = new Set<number>();
    for (const definition of definitions) {
      for (const dependency of dependencies[definition]!) {
        const dependencyComponent = componentByDefinition[dependency]!;
        if (dependencyComponent !== component) componentDependencies.add(dependencyComponent);
      }
    }
    return Object.freeze({
      definitions: Object.freeze(definitions),
      dependencies: Object.freeze([...componentDependencies].sort((left, right) => left - right)),
    });
  });
  return Object.freeze({
    definitionCount: dependencies.length,
    components: Object.freeze(components),
    componentByDefinition: Object.freeze(componentByDefinition),
  });
}

function definitionDependencies(
  definition: number,
  root: number,
  definitionCount: number,
  nodes: readonly LazuliCoreNode[],
): readonly number[] {
  const dependencies = new Set<number>();
  const visited = new Set<number>();
  const pending = [root];
  while (pending.length !== 0) {
    const nodeIndex = pending.pop()!;
    if (visited.has(nodeIndex)) continue;
    visited.add(nodeIndex);
    const node = nodes[nodeIndex];
    if (node === undefined) {
      throw new Error(
        `semantic definition d${definition} reaches core node ${nodeIndex} beyond ${nodes.length} nodes`,
      );
    }
    if (node.tag === LazuliCoreTag.Global) {
      if (node.payload >= definitionCount) {
        throw new Error(
          `semantic definition d${definition} references d${node.payload} beyond ${definitionCount} definitions`,
        );
      }
      dependencies.add(node.payload);
      continue;
    }
    for (const child of coreChildren(node)) {
      if (child !== LAZULI_NO_INDEX) pending.push(child);
    }
  }
  return Object.freeze([...dependencies].sort((left, right) => left - right));
}

function coreChildren(node: LazuliCoreNode): readonly number[] {
  switch (node.tag) {
    case LazuliCoreTag.Integer:
    case LazuliCoreTag.SignedInteger64:
    case LazuliCoreTag.Float32:
    case LazuliCoreTag.Float64:
    case LazuliCoreTag.WholeNumberF64:
    case LazuliCoreTag.Boolean:
    case LazuliCoreTag.Text:
    case LazuliCoreTag.Bytes:
    case LazuliCoreTag.RuntimeFault:
    case LazuliCoreTag.Local:
    case LazuliCoreTag.Global:
    case LazuliCoreTag.Constructor:
      return [];
    case LazuliCoreTag.Lambda:
    case LazuliCoreTag.Unary:
    case LazuliCoreTag.NumericConvert:
    case LazuliCoreTag.PatternBind:
      return [node.child0];
    case LazuliCoreTag.Apply:
    case LazuliCoreTag.Let:
    case LazuliCoreTag.LetRec:
    case LazuliCoreTag.Binary:
    case LazuliCoreTag.BufferAppend:
    case LazuliCoreTag.Case:
    case LazuliCoreTag.CaseArm:
      return [node.child0, node.child1];
    case LazuliCoreTag.If:
      return [node.child0, node.child1, node.child2];
  }
}

function packComponentGraphBatch(graphs: readonly SemanticDefinitionDependencyGraph[]): {
  readonly dependencyCounts: Uint32Array;
  readonly dependentOffsets: Uint32Array;
  readonly dependents: Uint32Array;
  readonly graphDescriptors: Uint32Array;
  readonly componentOffsets: Uint32Array;
  readonly componentCount: number;
} {
  const dependencyCounts: number[] = [];
  const dependentOffsets: number[] = [];
  const dependents: number[] = [];
  const graphDescriptors = new Uint32Array(graphs.length * GRAPH_DESCRIPTOR_WORDS);
  const componentOffsets = new Uint32Array(graphs.length);
  for (const [graphIndex, graph] of graphs.entries()) {
    const componentOffset = dependencyCounts.length;
    const componentCount = graph.components.length;
    let edgeCount = 0;
    if (componentCount > MAXIMUM_GRAPH_COMPONENTS) {
      throw new Error(
        `GPU semantic wavefront graph ${graphIndex} has ${componentCount} components but the bounded kernel supports at most ${MAXIMUM_GRAPH_COMPONENTS}`,
      );
    }
    componentOffsets[graphIndex] = componentOffset;
    const componentDependents = graph.components.map(() => [] as number[]);
    for (const [componentIndex, component] of graph.components.entries()) {
      dependencyCounts.push(component.dependencies.length);
      for (const dependency of component.dependencies) {
        if (!Number.isInteger(dependency) || dependency < 0 || dependency >= componentCount) {
          throw new Error(
            `GPU semantic wavefront graph ${graphIndex} component ${componentIndex} depends on component ${dependency} beyond ${componentCount} components`,
          );
        }
        componentDependents[dependency]!.push(componentOffset + componentIndex);
        edgeCount += 1;
      }
    }
    if (edgeCount > MAXIMUM_GRAPH_EDGES) {
      throw new Error(
        `GPU semantic wavefront graph ${graphIndex} has ${edgeCount} dependency edges but the bounded kernel supports at most ${MAXIMUM_GRAPH_EDGES}`,
      );
    }
    for (const targets of componentDependents) {
      dependentOffsets.push(dependents.length);
      dependents.push(...targets);
    }
    const descriptorOffset = graphIndex * GRAPH_DESCRIPTOR_WORDS;
    graphDescriptors[descriptorOffset] = componentOffset;
    graphDescriptors[descriptorOffset + 1] = componentCount;
  }
  return {
    dependencyCounts: Uint32Array.from(dependencyCounts.length === 0 ? [0] : dependencyCounts),
    dependentOffsets: Uint32Array.from([...dependentOffsets, dependents.length]),
    dependents: Uint32Array.from(dependents.length === 0 ? [0] : dependents),
    graphDescriptors,
    componentOffsets,
    componentCount: dependencyCounts.length,
  };
}

function wavefrontSchedule(componentWaves: readonly number[]): SemanticDefinitionWavefrontSchedule {
  const waveCount = componentWaves.length === 0 ? 0 : Math.max(...componentWaves) + 1;
  const wavefronts = Array.from({ length: waveCount }, () => [] as number[]);
  for (const [component, wave] of componentWaves.entries()) wavefronts[wave]!.push(component);
  return Object.freeze({
    componentWaves: Object.freeze([...componentWaves]),
    wavefronts: Object.freeze(wavefronts.map((frontier) => Object.freeze(frontier))),
  });
}

function storageBuffer(
  device: GPUDevice,
  label: string,
  words: Uint32Array,
  buffers: GPUBuffer[],
  additionalUsage = 0,
): GPUBuffer {
  const buffer = device.createBuffer({
    label,
    size: Math.max(4, words.byteLength),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | additionalUsage,
  });
  buffers.push(buffer);
  if (words.byteLength !== 0) device.queue.writeBuffer(buffer, 0, Uint32Array.from(words));
  return buffer;
}

function dispatch(
  commands: GPUCommandEncoder,
  pipeline: GPUComputePipeline,
  bindings: GPUBindGroup,
  workgroups: number,
): void {
  const pass = commands.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindings);
  pass.dispatchWorkgroups(workgroups);
  pass.end();
}

const SEMANTIC_DEFINITION_WAVEFRONT_SHADER = /* wgsl */ `
struct Words { values: array<u32> }

@group(0) @binding(0) var<storage, read_write> dependency_counts: Words;
@group(0) @binding(1) var<storage, read> dependent_offsets: Words;
@group(0) @binding(2) var<storage, read> dependents: Words;
@group(0) @binding(3) var<storage, read_write> waves: Words;
@group(0) @binding(4) var<storage, read> graph_descriptors: Words;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn schedule_wavefronts(
  @builtin(global_invocation_id) invocation: vec3<u32>,
) {
  let graph = invocation.x;
  let descriptor = graph * ${GRAPH_DESCRIPTOR_WORDS}u;
  if descriptor >= arrayLength(&graph_descriptors.values) { return; }
  let component_offset = graph_descriptors.values[descriptor];
  let component_count = graph_descriptors.values[descriptor + 1u];

  for (var wave = 0u; wave < component_count; wave += 1u) {
    var advanced = false;
    let encoded_wave = wave + 1u;
    for (var local_component = 0u; local_component < component_count; local_component += 1u) {
      let component = component_offset + local_component;
      if dependency_counts.values[component] == 0u &&
          waves.values[component] == ${GPU_UNSCHEDULED_WAVE}u {
        waves.values[component] = encoded_wave;
        advanced = true;
      }
    }
    if !advanced { break; }

    for (var local_component = 0u; local_component < component_count; local_component += 1u) {
      let component = component_offset + local_component;
      if waves.values[component] != encoded_wave { continue; }
      let start = dependent_offsets.values[component];
      let end = dependent_offsets.values[component + 1u];
      for (var edge = start; edge < end; edge += 1u) {
        dependency_counts.values[dependents.values[edge]] -= 1u;
      }
    }
  }
}
`;
