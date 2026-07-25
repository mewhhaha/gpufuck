export interface SourceRange {
  readonly module: string;
  readonly startByte: number;
  readonly endByte: number;
}

export interface WasmExportDeclaration {
  readonly name: string;
  readonly definition: string;
}

const MODULE_NAME_SEPARATOR = "::";

export function matchesQualifiedName(actual: string, localName: string): boolean {
  return actual === localName || actual.endsWith(`${MODULE_NAME_SEPARATOR}${localName}`);
}

export function unqualifiedName(name: string): string {
  const separator = name.lastIndexOf(MODULE_NAME_SEPARATOR);
  return separator < 0 ? name : name.slice(separator + MODULE_NAME_SEPARATOR.length);
}
