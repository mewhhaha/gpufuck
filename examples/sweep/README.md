# Sweep

A language whose rules exist so that compiling it could be a bottom-up sweep rather than a global
solve. [DESIGN.md](../../DESIGN.md) is the argument; this directory is what it looks like.

Run one:

```sh
deno task run:sweep examples/sweep/shapes.sweep
```

| Sample                                     | What it shows                                      | Result |
| ------------------------------------------ | -------------------------------------------------- | -----: |
| [`factorial.sweep`](factorial.sweep)       | Recursion, with no `rec` keyword or binding group  |    120 |
| [`option.sweep`](option.sweep)             | A generic nominal type and explicit type arguments |     42 |
| [`shapes.sweep`](shapes.sweep)             | Single-level matching, exports, flat locals        |     42 |
| [`higher_order.sweep`](higher_order.sweep) | Function types and n-ary parameter lists           |     43 |
| [`editor.sweep`](editor.sweep)             | 280 lines: a terminal editor's pure core           |      8 |
| [`vim.sweep`](vim.sweep)                   | A modal editor, driven by a real terminal          |      — |

## The whole language

```
type Shape = Circle(radius: Int) | Rect(width: Int, height: Int) | Point;

export area;

fn area(shape: Shape) -> Int =
  match shape {
    Circle(radius) -> 3 * radius * radius;
    Rect(width, height) -> width * height;
    Point -> 0;
  };

fn unwrap[T](option: Option[T], fallback: T) -> T =
  match option {
    None -> fallback;
    Some(value) -> value;
  };

fn main() -> Int =
  let box: Int = area(Rect(6, 7)) in
  if box > 0 then box else 0;
```

That is all of it. Integers and booleans, `let`, `if`, `match`, calls, constructors, and the five
comparison operators. There is no unannotated binding, no or-pattern, no nested pattern, no
shadowing, no type alias, and no inferred type argument — each absence is a rule from DESIGN.md, and
each one is enforced rather than described. `tests/sweep_test.ts` has a case per rule proving a
violation is rejected.

## What each rule costs to break

The four the compiler rejects outright:

```
fn f(x) -> Int = x;                      -- rule 1: no syntax for an unannotated parameter
let x: Int = 1 in let x: Int = 2 in x    -- rule 5: "x" is already bound
export missing;                          -- rule 7: exported name is not defined
fn helper() -> Int = 1;                  -- a module with no "main"
```

Rule 4 is the one that pays, and it pays by exclusion rather than by speed. There is no way to write
the multi-subject or-pattern that costs Gleam 13–16x per arm and hard-fails at four
([BASELINE.md](../../BASELINE.md)), because the grammar has no or-patterns and no nesting. Programs
that do not compile at all in Gleam compile here.

## A realistic size

[`editor.sweep`](editor.sweep) is the pure core of a terminal editor — a zipper buffer, a cursor,
and an edit loop over eleven key commands — in 280 lines with no I/O, no strings, and no built-in
collections. Everything is nominal data and recursion, which is what the language has.
`deno task bench:sweep-editor` measures it: 718 surface nodes, 34 definitions, 0.93 ms to parse and
lower, 23.7 ms on the GPU, 24.8 KB of WebAssembly.

The one figure there worth quoting is parse throughput, **0.106 µs/byte against baba's 1.20** — the
same measurement on both sides, so a hand-written parser for a small grammar really is 12x faster.
Transitions-per-node looks good too and should be ignored; BASELINE.md explains why it is an
artifact of program size rather than of language design.

## A running editor

[`vim.sweep`](vim.sweep) is a modal editor — buffer, cursor, normal and insert modes, and every
command — and `sweep_vim.ts` is its host. Run it:

```sh
deno task vim
```

`h j k l` move, `0` and `$` jump, `i a A I` and `o` enter insert, `x` deletes, `J` joins, `q` quits;
in insert mode ESC returns to normal and Enter splits the line.

The split is the point. The host puts the terminal in raw mode, appends each keypress to a list,
hands the whole list to WebAssembly, and draws what comes back. It holds no buffer, no cursor, and
no mode, so there is nothing in it that can disagree with the Sweep program. State crosses the
boundary as a constructor tree — `Document(Buffer, Zipper, Buffer)` arrives in TypeScript as nested
`{ kind: "constructor", name, fields }`.

Sweep compiles once on the GPU at startup, about 85 ms. Each keystroke then replays the session from
empty, which sounds quadratic and measures linear because each key is O(1) on a zipper:

| Keys replayed | Latency | Per key |
| ------------: | ------: | ------: |
|            25 |  0.2 ms |  9.4 µs |
|           400 |  1.2 ms |  3.0 µs |
|         2,000 |  3.2 ms |  1.6 µs |

One limit worth knowing if you build something similar: every character is a `Char` constructor in
the returned value, and the decoder defaults to 2,047 nodes — roughly a thousand characters. The
host raises `maximumResultNodes`, and finding out why an editor stopped at a thousand characters is
the kind of thing only building the real thing tells you.

## It is not faster

Measured against Lazuli on the same computation with `deno task bench:sweep`: **identical node
counts, transition counts within noise.** On a nine-arm nested match — the one shape where the
single-level rule might have paid, since Lazuli desugars and Sweep nests by hand — Sweep is
marginally _worse_, 38 nodes against 35. Rules 1 and 3 need backend changes to pay — a checking
kernel instead of a solver, and an n-ary lambda node instead of unary arrows — and rules 5, 6, and 7
do not touch this pipeline at all.

So Sweep is a frontend waiting for a backend, and the honest reason it exists is to be the thing
that backend is measured against.
