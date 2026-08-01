# Canonical Core Wasm adapters

`WasmCompilationOptions.canonicalAbi` asks the linear-memory backend to publish a caller-facing
synchronous memory32 Canonical ABI interface. This interface is separate from `WasmValueAbi`: the
latter remains gpufuck's private tagged-value and heap contract.

The descriptor supplies structural unit, signed-i64, boolean, text, array, record, variant, and
sealed types. Record and variant names must be uniquely sorted. Constructor names connect those
structural descriptions to Core only while generating adapters; callers use field names, case names,
and canonical layouts rather than constructor indices.

Each record field also carries its private Core constructor slot. This lets canonical memory remain
name-sorted without changing a frontend's source record order. A frontend should omit that adapter
metadata from its public manifest.

The backend:

- validates the descriptor against compiled exports, host operations, and constructor arities;
- lifts borrowed parameters and host results into private Core values;
- lowers export results and host arguments into canonical memory;
- emits `cabi_realloc`;
- emits post-return functions for indirect export results;
- validates booleans, discriminants, lengths, and UTF-8 at the boundary; and
- exports immutable `blot:abi-major` and `blot:abi-minor` globals for the Blot profile.

Strings use UTF-8. Arrays recursively use their element memory layout. The backend applies the
Component Model limits of 16 flat parameters and one flat result, using indirect canonical records
beyond those limits.

Canonical allocation keeps the runtime allocator's metadata in a hidden sixteen-byte prefix. Caller
writes therefore cannot overwrite free-list metadata. The generated post-return recursively releases
nested strings and arrays before releasing an indirect result record.

Canonical ABI options are intentionally unavailable with the WasmGC backend. Compilation with a
descriptor bypasses shared artifact caches because the descriptor changes the emitted public
interface.

## Component boundary

`compileModuleToComponentBoundary(module, canonicalAbi, options)` pairs the canonical Core Wasm with
deterministic WIT. Component export, import, field, case, type, and world names must be lower-kebab
WIT identifiers. The current adapter uses the legacy canonical Core names supported by `wasm-tools`:
direct export names, `memory`, `cabi_realloc`, `cabi_post_<export>`, and `$root` imports.

The library does not shell out during compilation. Wrap and verify the pair with the Component
toolchain at the packaging boundary:

```sh
wasm-tools component embed calculator.wit calculator.core.wasm -o calculator.embedded.wasm
wasm-tools component new calculator.embedded.wasm -o calculator.component.wasm
wasm-tools component wit calculator.component.wasm
wasmtime run --invoke 'add(20, 22)' calculator.component.wasm
```

`tools/verify_component_boundary.ts` exercises those commands and also transpiles and invokes the
result through `@bytecodealliance/jco@1.26.1`.

`ComponentReloadSlot` is the corresponding host-side reload primitive. It health-checks a candidate
with the exact active WIT contract before one atomic routing swap, sends new calls to the candidate,
and disposes the retired version after its active calls drain. Mutable application state stays in
the host and is passed to either version; component memories are not treated as shared reload state.
