export interface BlotStressProject {
  readonly entryPath: string;
  readonly sources: Readonly<Record<string, string>>;
  readonly moduleCount: number;
  readonly definitionCount: number;
  readonly lineCount: number;
  readonly sourceBytes: number;
}

const MODULE_COUNT = 24;
const DEFINITIONS_PER_MODULE = 24;

export function createBlotStressProject(): BlotStressProject {
  const entryPath = "/examples/stress-project.blot";
  const sources: Record<string, string> = {};
  const resultNames: string[] = [];

  for (let moduleIndex = 0; moduleIndex < MODULE_COUNT; moduleIndex += 1) {
    const moduleName = moduleIndex.toString().padStart(2, "0");
    const definitions: string[] = [];
    for (let definitionIndex = 0; definitionIndex < DEFINITIONS_PER_MODULE; definitionIndex += 1) {
      const definitionName = `step_${definitionIndex.toString().padStart(2, "0")}`;
      const input = definitionIndex === 0
        ? "value"
        : `step_${(definitionIndex - 1).toString().padStart(2, "0")} value`;
      definitions.push(`let ${definitionName} = value => ${input} + 1;`);
    }
    sources[`/examples/stress/module_${moduleName}.blot`] = [
      "module {};",
      'open {} = (@import "blot:prelude") ();',
      "",
      ...definitions,
      "",
      `return { .run = step_${(DEFINITIONS_PER_MODULE - 1).toString().padStart(2, "0")}; };`,
      "",
    ].join("\n");
    resultNames.push(`result_${moduleName}`);
  }

  const imports = resultNames.map((name) => {
    const moduleName = name.slice("result_".length);
    return [
      `const module_${moduleName} = @import \"./stress/module_${moduleName}.blot\";`,
      `let ${name} = module_${moduleName} {};`,
    ].join("\n");
  });
  sources[entryPath] = [
    "// Synthetic project workload: every imported function is reachable from an export.",
    "",
    ...imports,
    "",
    "return {",
    ...resultNames.map((name) => `  .${name} = ${name}.run;`),
    "};",
    "",
  ].join("\n");

  const projectSources = Object.values(sources);
  return {
    entryPath,
    sources,
    moduleCount: MODULE_COUNT + 1,
    definitionCount: MODULE_COUNT * DEFINITIONS_PER_MODULE,
    lineCount: projectSources.reduce((total, source) => total + source.split("\n").length, 0),
    sourceBytes: projectSources.reduce(
      (total, source) => total + new TextEncoder().encode(source).byteLength,
      0,
    ),
  };
}
