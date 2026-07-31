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
