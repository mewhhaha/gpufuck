/**
 * How much does a multi-subject `case` with or-patterns cost to lower?
 *
 * Recorded in BASELINE: two subjects and two or-alternatives per arm cost 94 surface nodes at one
 * arm, 1,214 at two, 19,134 at three, and four arms exceeds the 65,536-node ABI cap and throws. This
 * reproduces that curve so a fix can be judged against it, and separates the two candidate causes:
 *
 *   - **body duplication** — the same arm body lowered once per constructor cell of the decision
 *     tree, which grows as the product of the subjects' constructor counts;
 *   - **scrutinee re-binding** — the subject re-tested or re-bound per cell, which would grow the
 *     same way but with a body-size-independent constant.
 *
 * Growing the body independently of the arm count tells them apart: if node count scales with body
 * size times cells, it is the body.
 *
 * Usage: deno task measure:or-patterns
 *
 * @module
 */
import { type GleamSourceModule, lowerGleamSources } from "../gleam.ts";

/** Distinct pairs over three constructors, so each arm is a genuinely different cell. */
const PAIRS = [
  ["A", "A"],
  ["B", "B"],
  ["C", "C"],
  ["A", "B"],
  ["B", "C"],
  ["C", "A"],
  ["A", "C"],
  ["B", "A"],
  ["C", "B"],
] as const;

/**
 * `armCount` arms, each with two or-alternatives, over two subjects. `bodyTerms` sets the size of
 * every arm body without changing the pattern matrix, which is what isolates body duplication.
 */
function program(armCount: number, bodyTerms: number): string {
  const body = (seed: number) =>
    Array.from({ length: bodyTerms }, (_, term) => `${seed + term}`).join(" + ");
  const arms = Array.from({ length: armCount }, (_, index) => {
    const first = PAIRS[(index * 2) % PAIRS.length]!;
    const second = PAIRS[(index * 2 + 1) % PAIRS.length]!;
    return `    ${first[0]}, ${first[1]} | ${second[0]}, ${second[1]} -> ${body(index + 1)}`;
  });
  return `pub type T {
  A
  B
  C
}

pub fn choose(x: T, y: T) -> Int {
  case x, y {
${arms.join("\n")}
    _, _ -> 0
  }
}

pub fn main() -> Int {
  choose(A, B)
}
`;
}

function nodeCount(source: string): number | string {
  const modules: GleamSourceModule[] = [{ name: "explosion", source }];
  try {
    const lowered = lowerGleamSources(modules, { module: "explosion", exportName: "main" });
    if (!lowered.ok) return `lowering failed: ${lowered.diagnostics[0]?.message}`;
    return lowered.lowered.module.nodeCount;
  } catch (error) {
    return `threw: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const ARM_COUNTS = [1, 2, 3, 4] as const;
const BODY_TERMS = [1, 2, 4] as const;

console.log("Two subjects over a 3-constructor type, two or-alternatives per arm.\n");
console.log("  arms | " + BODY_TERMS.map((t) => `body=${t}`.padStart(14)).join(" | "));
console.log("  -----+-" + BODY_TERMS.map(() => "-".repeat(14)).join("-+-"));
const counts = new Map<string, number | string>();
for (const arms of ARM_COUNTS) {
  const cells = BODY_TERMS.map((terms) => {
    const result = nodeCount(program(arms, terms));
    counts.set(`${arms}:${terms}`, result);
    return (typeof result === "number" ? result.toLocaleString() : "throws").padStart(14);
  });
  console.log(`  ${String(arms).padStart(4)} | ${cells.join(" | ")}`);
}

console.log("\nGrowth per added arm, at body=1:");
let previous: number | undefined;
for (const arms of ARM_COUNTS) {
  const value = counts.get(`${arms}:1`);
  if (typeof value !== "number") {
    console.log(`  ${arms} arms: ${value}`);
    continue;
  }
  console.log(
    `  ${arms} arms: ${value.toLocaleString()}` +
      (previous === undefined ? "" : `  (${(value / previous).toFixed(1)}x)`),
  );
  previous = value;
}

console.log("\nSensitivity to body size, which separates body duplication from re-binding:");
for (const arms of ARM_COUNTS) {
  const one = counts.get(`${arms}:1`);
  const four = counts.get(`${arms}:4`);
  if (typeof one !== "number" || typeof four !== "number") continue;
  // Each extra body term is 2 surface nodes (a literal and a binary), so a body lowered once per
  // cell makes this difference 6 nodes times the number of cells.
  console.log(
    `  ${arms} arms: body 1 -> 4 adds ${(four - one).toLocaleString()} nodes, ` +
      `implying ~${Math.round((four - one) / 6)} copies of the body`,
  );
}
