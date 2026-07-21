export interface FunctionalSourceRange {
  readonly module: string;
  readonly startByte: number;
  readonly endByte: number;
}

export interface FunctionalWasmExportDeclaration {
  readonly name: string;
  readonly definition: string;
}

const FUNCTIONAL_MODULE_NAME_SEPARATOR = "::";

export function matchesFunctionalQualifiedName(actual: string, localName: string): boolean {
  return actual === localName || actual.endsWith(`${FUNCTIONAL_MODULE_NAME_SEPARATOR}${localName}`);
}

export function unqualifiedFunctionalName(name: string): string {
  const separator = name.lastIndexOf(FUNCTIONAL_MODULE_NAME_SEPARATOR);
  return separator < 0 ? name : name.slice(separator + FUNCTIONAL_MODULE_NAME_SEPARATOR.length);
}
