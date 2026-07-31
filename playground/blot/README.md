# Vendored Blot playground compiler

This directory is a browser-targeted snapshot of `mewhhaha/blot` at
`67116cd3bf36d2856f3a41ce743e77bbd2730b16`.

The snapshot contains the production compiler passes, prelude, accepted examples, language
reference, and Baba 7.10.0 generated parser assets. Tests, command-line entry points, rejected
examples, and editor tooling are intentionally excluded from the browser bundle.

Three boundaries differ from the source repository:

- gpufuck imports point at this checkout's `functional.ts`;
- `src/load.ts` reads an explicitly configured in-memory source map instead of the filesystem;
- `src/syntax/parse.ts` fetches parser assets supplied by the playground build.

The copied TypeScript retains Blot's own compiler configuration. Each vendored source file has a
`@ts-nocheck` boundary because gpufuck additionally enables `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`; the browser adapter outside `src/` remains checked with gpufuck's
stricter settings.

`stress_project.ts` is gpufuck-owned. It generates the deterministic multi-module workload shared by
the browser showcase, benchmark, and regression test; it is not part of the Blot snapshot.
