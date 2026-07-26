/**
 * Generates a large corpus of realistic Gleam modules.
 *
 * Two shapes exist for "a big program", and gpufuck behaves oppositely on them, so a benchmark that
 * conflates them proves nothing:
 *
 *   - **one large module** — what a real project becomes, because the frontend links imports into a
 *     single module. This is the latency case, and the case gpufuck loses: 3.0x slower than
 *     `gleam build` on the Gleam standard library.
 *   - **many independent modules** — a playground, a package registry, a CI corpus. This is the
 *     throughput case, and the one a GPU can win, because `gleam build` has no cross-package
 *     batching and pays roughly 11 ms per package.
 *
 * The recorded 17x batch win was measured on two-definition modules, which is small enough that the
 * comparison is almost entirely against Gleam's per-package floor rather than against its compiler.
 * This generator exists to retest that claim at a module size somebody might actually write.
 *
 * Modules are generated rather than checked in: a few hundred thousand lines of synthetic Gleam is
 * repo bloat, and the shapes here are chosen from BASELINE's per-construct costs rather than from
 * observing real code, so it is not a corpus anyone should read.
 *
 * Usage: deno task generate:corpus <target-directory> [module-count]
 *
 * @module
 */

/** Distinct enough per module that nothing is shared or deduplicated by accident. */
function moduleSource(index: number, functionsPerModule: number): string {
  const salt = index % 7 + 1;
  const parts: string[] = [
    `// Generated module ${index}. See tools/generate_gleam_corpus.ts.`,
    "",
    `pub type Shape${index} {`,
    `  Circle${index}(radius: Int)`,
    `  Rect${index}(width: Int, height: Int)`,
    `  Empty${index}`,
    "}",
    "",
    `pub type Tree${index} {`,
    `  Leaf${index}(value: Int)`,
    `  Node${index}(left: Tree${index}, right: Tree${index})`,
    "}",
    "",
  ];

  for (let group = 0; group < functionsPerModule; group++) {
    parts.push(
      // Constructor plus `case` is the most expensive construct measured, at 166 transitions per use.
      `fn area_${group}(shape) {`,
      "  case shape {",
      `    Circle${index}(radius: r) -> ${salt} * r * r`,
      `    Rect${index}(width: w, height: h) -> w * h + ${group}`,
      `    Empty${index} -> 0`,
      "  }",
      "}",
      "",
      // Recursion over a nominal tree, so inference has to work through a recursive type.
      `fn depth_${group}(tree) {`,
      "  case tree {",
      `    Leaf${index}(value: v) -> v`,
      `    Node${index}(left: l, right: r) -> case depth_${group}(l) > depth_${group}(r) {`,
      `      True -> depth_${group}(l) + 1`,
      `      False -> depth_${group}(r) + 1`,
      "    }",
      "  }",
      "}",
      "",
      // A tail-recursive accumulator, which is the shape contification and the tail loop care about.
      `fn total_${group}(n, acc) {`,
      "  case n <= 0 {",
      "    True -> acc",
      `    False -> total_${group}(n - 1, acc + n * ${salt})`,
      "  }",
      "}",
      "",
      // A guard, which routes through lowerSequentialCase and its fallback join points.
      `fn clamp_${group}(value) {`,
      "  case value {",
      `    v if v > 1000 -> 1000`,
      "    v if v < 0 -> 0",
      "    v -> v",
      "  }",
      "}",
      "",
      // Result plumbing, for polymorphic instantiation.
      `fn checked_${group}(numerator, denominator) {`,
      "  case denominator {",
      `    0 -> Error("divide by zero")`,
      "    d -> Ok(numerator / d)",
      "  }",
      "}",
      "",
      `fn score_${group}(seed) {`,
      `  let shape = Rect${index}(width: seed, height: ${group + 1})`,
      `  let tree = Node${index}(Leaf${index}(seed), Node${index}(Leaf${index}(${group}), Leaf${index}(${salt})))`,
      `  case checked_${group}(area_${group}(shape), depth_${group}(tree)) {`,
      `    Ok(value) -> clamp_${group}(total_${group}(value % 16, 0))`,
      "    Error(_) -> 0",
      "  }",
      "}",
      "",
    );
  }

  const sum = Array.from(
    { length: functionsPerModule },
    (_, group) => `score_${group}(${group % 9 + 1})`,
  );
  parts.push(`pub fn main() -> Int {`, `  ${sum.join(" + ")}`, "}", "");
  return parts.join("\n");
}

export interface GeneratedCorpus {
  readonly modules: readonly { readonly name: string; readonly source: string }[];
  readonly sourceBytes: number;
}

export function generateGleamCorpus(
  moduleCount: number,
  functionsPerModule: number,
): GeneratedCorpus {
  const modules = Array.from({ length: moduleCount }, (_, index) => ({
    name: `corpus/module_${index}`,
    source: moduleSource(index, functionsPerModule),
  }));
  const sourceBytes = modules.reduce(
    (total, module) => total + new TextEncoder().encode(module.source).byteLength,
    0,
  );
  return { modules, sourceBytes };
}

if (import.meta.main) {
  const target = Deno.args[0];
  if (target === undefined) {
    console.error("usage: generate_gleam_corpus.ts <target-directory> [module-count]");
    Deno.exit(2);
  }
  const moduleCount = Number.parseInt(Deno.args[1] ?? "256", 10);
  const corpus = generateGleamCorpus(moduleCount, 6);
  await Deno.mkdir(target, { recursive: true });
  for (const module of corpus.modules) {
    await Deno.writeTextFile(
      `${target}/${module.name.replace("corpus/", "")}.gleam`,
      module.source,
    );
  }
  console.log(
    `${corpus.modules.length} modules, ${(corpus.sourceBytes / 1024).toFixed(0)} KB of Gleam ` +
      `in ${target}`,
  );
}
