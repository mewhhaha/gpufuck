import { GpuLazuliCompiler, requestWebGpuDevice } from "../mod.ts";

interface CompilationBenchmark {
  readonly name: string;
  readonly source: string;
}

const wideGlobalSource = [
  ...Array.from(
    { length: 64 },
    (_, index) => `fn value${index} = ${index};`,
  ),
  "fn main = value63;",
].join("\n");

const benchmarks: readonly CompilationBenchmark[] = [
  {
    name: "small arithmetic",
    source: "fn main = 6 * 7;",
  },
  {
    name: "recursive factorial",
    source: `fn factorial n =
      if n == 0 then 1 else n * factorial (n - 1);
      fn main = factorial 6;`,
  },
  {
    name: "lazy algebraic list",
    source: `      let sum = values => case values of
        | Nil -> 0
        | Cons(head, tail) -> head + sum tail
      end;
      fn main = sum (Cons 20 (Cons 22 Nil));`,
  },
  {
    name: "const-specialized rich values",
    source: `      data Line = Line(price: Int, quantity: Int);
      const identity[T] = value => value;
      let line_total = line => case line of
        | Line(price, quantity) -> price * quantity
      end;
      let main = line_total (identity[Line] Line { quantity: 2, price: 21 });`,
  },
  {
    name: "64 global definitions",
    source: wideGlobalSource,
  },
  {
    name: "polymorphic let reuse",
    source: `let identity = value => value;
      let main = (identity 42, identity true);`,
  },
  {
    name: "generic recursive tree",
    source: `data Tree value =
        Leaf(value: value)
        | Branch(left: Tree value, right: Tree value);
      let sum = tree => case tree of
        | Leaf(value) -> value
        | Branch(left, right) -> sum left + sum right
      end;
      let main = sum (Branch (Leaf 20) (Leaf 22));`,
  },
  {
    name: "wide exhaustive algebraic type",
    source: `data Wide = A | B | C | D | E | F | G | H;
      let main = value => case value of
        | A -> 1 | B -> 2 | C -> 3 | D -> 4
        | E -> 5 | F -> 6 | G -> 7 | H -> 8
      end;
      let answer = main H;`,
  },
  {
    name: "recursive definition SCC",
    source: `let even = value => if value == 0 then true else odd (value - 1);
      let odd = value => if value == 0 then false else even (value - 1);
      let main = even 42;`,
  },
];

const device = await requestWebGpuDevice();
const compiler = await GpuLazuliCompiler.create(device);
globalThis.addEventListener("unload", () => device.destroy(), { once: true });

for (const benchmark of benchmarks) {
  Deno.bench({
    name: `compile Lazuli: ${benchmark.name}`,
    async fn(context) {
      context.start();
      const compilation = await compiler.compile(benchmark.source);
      context.end();

      if (!compilation.ok) {
        throw new Error(
          `benchmark source ${JSON.stringify(benchmark.name)} did not compile: ${
            compilation.diagnostics[0].message
          }`,
        );
      }
      compilation.module.destroy();
    },
  });
}
