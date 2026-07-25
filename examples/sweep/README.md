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

## It is not faster

Measured against Lazuli on the same computation with `deno task bench:sweep`: **identical node
counts, transition counts within noise.** Rules 1 and 3 need backend changes to pay — a checking
kernel instead of a solver, and an n-ary lambda node instead of unary arrows — and rules 5, 6, and 7
do not touch this pipeline at all.

So Sweep is a frontend waiting for a backend, and the honest reason it exists is to be the thing
that backend is measured against.
