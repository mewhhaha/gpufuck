export interface GpuLazuliSemanticCompilationPass {
  readonly pipeline: GPUComputePipeline;
  readonly bindGroup: GPUBindGroup;
  readonly stateBuffer: GPUBuffer;
}

export interface GpuLazuliSemanticStateSnapshot {
  readonly nodeCount: number;
  readonly definitionCount: number;
  readonly typeCount: number;
  readonly constructorCount: number;
  readonly entrySymbol: number;
  readonly status: number;
  readonly errorCode: number;
  readonly errorSource: number;
  readonly errorDetail: number;
  readonly entryDefinition: number;
  readonly totalSteps: number;
  readonly maximumSteps: number;
  readonly maximumStepsPerDispatch: number;
}
