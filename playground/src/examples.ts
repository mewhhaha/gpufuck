export interface LazuliExample {
  readonly name: string;
  readonly path: string;
}

export async function loadExampleManifest(): Promise<readonly LazuliExample[]> {
  const response = await fetch(playgroundAssetPath("generated/examples.json"));
  if (!response.ok) {
    throw new Error(`could not load browser examples: HTTP ${response.status}`);
  }
  const value: unknown = await response.json();
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("browser example manifest must contain at least one example");
  }
  return value.map(parseExample);
}

export async function loadExampleSource(example: LazuliExample): Promise<string> {
  const response = await fetch(playgroundAssetPath(example.path));
  if (!response.ok) {
    throw new Error(`could not load Lazuli example ${example.path}: HTTP ${response.status}`);
  }
  return await response.text();
}

function playgroundAssetPath(path: string): string {
  return `${import.meta.env.BASE_URL}${path}`;
}

function parseExample(value: unknown, index: number): LazuliExample {
  if (typeof value !== "object" || value === null) {
    throw new Error(`browser example ${index} must be an object`);
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.name !== "string" || candidate.name.length === 0) {
    throw new Error(`browser example ${index} has no name`);
  }
  if (
    typeof candidate.path !== "string" ||
    !candidate.path.startsWith("generated/sources/") ||
    candidate.path.includes("..")
  ) {
    throw new Error(`browser example ${index} has unsafe path ${JSON.stringify(candidate.path)}`);
  }
  return { name: candidate.name, path: candidate.path };
}
