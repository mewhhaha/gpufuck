export interface GpuFunctionalSemanticPipelines {
  readonly compilation: GPUComputePipeline;
  readonly plannedLowering: GPUComputePipeline;
}

export interface GpuFunctionalSemanticCompilationPass {
  readonly pipelines: GpuFunctionalSemanticPipelines;
  readonly bindGroup: GPUBindGroup;
  readonly stateBuffer: GPUBuffer;
  readonly plannedLoweringWorkgroups: number;
}

export interface GpuFunctionalSemanticStateSnapshot {
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
