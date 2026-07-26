/**
 * The multi-subject or-pattern program, shared by the measurement tool and the benchmark suite.
 *
 * Extracted so the two cannot drift: `measure:or-patterns` explains the shape and `bench` guards
 * against it regressing, and a guard that measured a slightly different program than the one
 * documented would be worse than no guard.
 *
 * @module
 */

/** Distinct pairs over three constructors, so each arm is a genuinely different decision-tree cell. */
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
 * `armCount` arms, each with two or-alternatives, over two subjects.
 *
 * `bodyTerms` sets the size of every arm body without changing the pattern matrix, which is what
 * separates body duplication from scrutinee re-binding: if node count scales with body size times
 * cells, the bodies are being copied.
 */
export function orPatternProgram(armCount: number, bodyTerms: number): string {
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
