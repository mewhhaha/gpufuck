export interface FunctionalSourceRange {
  readonly module: string;
  readonly startByte: number;
  readonly endByte: number;
}

export interface FunctionalWasmExportDeclaration {
  readonly name: string;
  readonly definition: string;
}
