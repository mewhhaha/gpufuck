# Functional IR examples

These examples target the language-neutral APIs directly.

- [`type_program.ts`](type_program.ts) applies a higher-kinded `Twice` type function and resolves an
  associated `element` family from capability evidence. Both results normalize to the first-order
  schema accepted by the GPU inference ABI.
- [`effects.ts`](effects.ts) declares `Reader.ask`, supplies a typed handler, lowers the computation
  to explicit continuations, and evaluates the handled program on the GPU. The effect row changes
  from `Reader.ask` to empty at the handler boundary and the value is 42.
- [`effect_core.ts`](effect_core.ts) sends portable `bind` and `host-call` computations through the
  bounded GPU Effect Core verifier, then runs the compiler-generated sequence through WASM.
- [`host_init.ts`](host_init.ts) declares an effectful `Console.write` capability, GPU-typechecks an
  `Init -> Int` entry, imports the host operation into WASM, and forces it before returning 42.

Run them from the repository root:

```sh
deno run examples/functional-ir/type_program.ts
deno run --allow-read examples/functional-ir/effects.ts
deno run --allow-read examples/functional-ir/effect_core.ts
deno run --allow-read examples/functional-ir/host_init.ts
```
