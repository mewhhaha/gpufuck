# Type-programming profiles

These experiments map small, real language-shaped programs into the neutral Type Core. They test the
semantic backend boundary, not complete Idris2 or Zig syntax frontends. The paired `.idr` and `.zig`
files show the source construct being represented; the adjacent TypeScript files contain the
explicit lowering and executable pipeline.

## Idris2-style indexed types

[`idris2_vector.idr`](idris2_vector.idr) defines Peano addition and asks for
`Vect (appendLength 2 1) Int`. [`idris2_vector.ts`](idris2_vector.ts) lowers `Nat` constructors to
structural Type Core types and runs recursive normalization on the GPU. The resulting `Vect 3 Int`
schema is then staged into an ordinary functional module, where GPU inference verifies that three
`Cons` constructors ending in `Nil` have exactly that index. Deep GPU evaluation returns the checked
vector.

This exercises closed type-level functions, structural dependent indices, indexed constructor
results, and staging a computed type into value checking. It does not implement Idris2 elaboration,
implicit arguments, dependent function (`Pi`) types, universe checking, totality checking, or
term-dependent indices.

## Zig-style comptime

[`zig_comptime.zig`](zig_comptime.zig) defines `Matrix` and `cellCount` using `comptime` parameters.
[`zig_comptime.ts`](zig_comptime.ts) lowers those closed computations to Type Core. The GPU
constructs the mixed-kinded type `Array 6 (Array 7 i32)`, computes `42`, and stages that constant
into a normal functional module whose generated WebAssembly returns `42`.

[`zig_reflection.zig`](zig_reflection.zig) goes further: its generic `WithGetter` function
synthesizes a struct, attaches a `get` method, and uses `inline for` with `std.meta.fields` to
inspect its fields. [`zig_reflection_program.ts`](zig_reflection_program.ts) represents that
metadata as recursive Type Core values. GPU execution walks the field list to compute its five
payload bytes and searches the method table by symbol. [`zig_reflection.ts`](zig_reflection.ts) then
erases the selected method to a direct call in the functional IR; GPU inference checks the
specialized module and its generated WebAssembly returns `42`. A missing method produces an explicit
sentinel rather than accidentally selecting a declaration.

The checked-in Zig sources are independently tested with Zig itself. These experiments do not yet
model arbitrary compile-time memory, imperative compile-time loops, `@compileError`, aggregate
layout and alignment, or general specialized term generation. Mixed-kinded Type Core values such as
array lengths must currently be erased or lowered to a frontend-generated nominal runtime type
before they can enter the functional schema ABI.

Run the GPU pipelines from the repository root:

```sh
deno task run:idris2-type-programming
deno task run:zig-comptime
deno task run:zig-reflection
```

Compare GPU startup and steady-state latency, fresh-cache Zig compilation, and 32-program throughput
against the paired native Zig tests:

```sh
deno task compare:type-programming
```

The comparison reports complete pipelines rather than pretending the phases are identical. The GPU
initialization probe includes its first program and lazy shader and pipeline initialization. Warm
GPU times include Type Core validation, lowering, semantic compilation, execution, and readback; the
GPU batch submits programs concurrently. Zig first times use an empty cache and include process
startup, parsing, semantic analysis, code generation, linking, and test execution; the Zig batch is
sequential and uses a warm cache.
