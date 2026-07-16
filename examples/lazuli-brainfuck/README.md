# A compiler written in Lazuli

[`compiler.laz`](compiler.laz) is a Brainfuck-to-WebAssembly compiler whose public type is
`Text -> Text`. It filters comments, validates bracket nesting, recursively lowers all eight
Brainfuck instructions, constructs a complete WebAssembly module, encodes section lengths as
unsigned LEB128, and returns the binary as lowercase hexadecimal text.

The hexadecimal boundary is deliberate: arbitrary WebAssembly bytes are not necessarily valid UTF-8,
while hexadecimal preserves the requested string-to-string compiler contract. The host runner
decodes and validates that text without changing the compiler's semantics.

```sh
deno task run:lazuli-brainfuck
deno task run:lazuli-brainfuck '++++++++[>++++++++<-]>+.'
```

The pipeline is intentionally recursive: the host parses Lazuli, GPU compilation resolves and
typechecks the compiler, GPU evaluation runs that compiler over Brainfuck source, and the emitted
WebAssembly then executes through the host engine. The runner reports the one-time Lazuli compiler
and evaluator initialization, first-dispatch shader warmup, Lazuli compiler compilation, and
per-input Brainfuck compilation latencies separately. An empty-input probe isolates evaluator shader
warmup before five repeated inputs expose the warm path. The runner also times the existing
specialized GPU Brainfuck-to-IR compiler as a clearly labelled, non-equivalent lower-bound
comparison.
