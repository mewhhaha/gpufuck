import { deepStrictEqual, equal, match, ok } from "node:assert/strict";

import {
  GpuFunctionalCompiler,
  requestWebGpuDevice,
  runFunctionalWasmModule,
} from "../functional.ts";
import { lowerJavaScriptAotSource } from "../examples/javascript-aot/mod.ts";

let device: GPUDevice | undefined;
let compiler: GpuFunctionalCompiler | undefined;

Deno.test.beforeAll(async () => {
  device = await requestWebGpuDevice();
  compiler = await GpuFunctionalCompiler.create(device);
});

Deno.test.afterAll(() => {
  device?.destroy();
  device = undefined;
  compiler = undefined;
});

Deno.test("compiles recursive JavaScript number code through the GPU and runs its Wasm", async () => {
  const value = await compileAndRun(`
function factorial(value) {
  if (value === 0) {
    return 1;
  }
  return value * factorial(value - 1);
}

export function main() {
  return factorial(5);
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 120 });
});

Deno.test("preserves lexical block scope while lowering JavaScript returns", async () => {
  const value = await compileAndRun(`
function classify(value) {
  if (value >= 40) {
    const offset = 2;
    return value + offset;
  }
  return 0;
}

export function main() {
  const offset = 100;
  return classify(40) === 42 && offset === 100 ? 42 : 0;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("runs object identity and property access through the JavaScript runtime model", async () => {
  const value = await compileAndRun(`
export function main() {
  const left = { first: 40 };
  let right = { second: 2 };
  right = right;
  return ({}) === ({}) ? 0 : left.first + right.second;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("returns runtime object identity comparisons across the Wasm boundary", async () => {
  const value = await compileAndRun(`
export function main() {
  return ({ answer: 42 }) !== ({ answer: 42 });
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("persists JavaScript property assignment in the runtime heap", async () => {
  const value = await compileAndRun(`
export function main() {
  const point = { x: 40 };
  point.x = 41;
  point["y"] = 1;
  return point.x + point.y;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("hoists and updates runtime var bindings around object mutation", async () => {
  const value = await compileAndRun(`
export function main() {
  point = { answer: 40 };
  var point;
  point.answer = 42;
  return point.answer + 0;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("calls a runtime function object with its captured lexical environment", async () => {
  const value = await compileAndRun(`
export function main() {
  const offset = 2;
  const add = function(value) { return value + offset; };
  return function() {} === function() {} ? 0 : add(40) + 0;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("shares mutable binding cells between a closure and its caller", async () => {
  const value = await compileAndRun(`
export function main() {
  let counter = 40;
  const increment = function() {
    counter = counter + 1;
    return counter;
  };
  if (function() {} === function() {}) return 0;
  increment();
  return increment() + 0;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("hoists mutually recursive runtime function declarations", async () => {
  const value = await compileAndRun(`
export function main() {
  function even(value) {
    if (value === 0) return true;
    return odd(value - 1);
  }
  function odd(value) {
    if (value === 0) return false;
    return even(value - 1);
  }
  if (function() {} === function() {}) return false;
  return even(10) === true;
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("keeps a named runtime function expression recursive and locally scoped", async () => {
  const value = await compileAndRun(`
export function main() {
  const factorial = function recurse(value) {
    if (value === 0) return 1;
    return value * recurse(value - 1);
  };
  if (function() {} === function() {}) return 0;
  return factorial(5) + 0;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 120 });
});

Deno.test("restores lexical block environments while preserving captured cells", async () => {
  const value = await compileAndRun(`
export function main() {
  let read = function() { return 0; };
  let answer = 40;
  {
    let answer = 42;
    read = function() { return answer; };
  }
  if (function() {} === function() {}) return 0;
  return read() + answer - 40;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("fills missing runtime arguments with undefined and ignores extras", async () => {
  const value = await compileAndRun(`
export function main() {
  const missing = function(first, second) { return second === undefined; };
  const extra = function(first) { return first; };
  if (function() {} === function() {}) return 0;
  if (missing(1) !== true) return 0;
  return extra(42, 99) + 0;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("catches a completion thrown across a runtime function call", async () => {
  const value = await compileAndRun(`
export function main() {
  const fail = function() { throw 40; };
  if (function() {} === function() {}) return 0;
  try {
    fail();
    return 0;
  } catch (reason) {
    return reason + 2;
  }
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("catches a thrown JavaScript value and exposes the lexical catch binding", async () => {
  const value = await compileAndRun(`
export function main() {
  try {
    throw 40;
  } catch (reason) {
    return reason + 2;
  }
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("propagates a rethrown JavaScript value to the next lexical catch", async () => {
  const value = await compileAndRun(`
export function main() {
  try {
    try {
      throw 40;
    } catch (reason) {
      throw reason + 1;
    }
  } catch (reason) {
    return reason + 1;
  }
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("supports JavaScript catch clauses without a binding", async () => {
  const value = await compileAndRun(`
export function main() {
  try {
    throw "ignored";
  } catch {
    return 42;
  }
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("restores an outer binding shadowed by a JavaScript catch parameter", async () => {
  const value = await compileAndRun(`
export function main() {
  var reason = 40;
  try {
    throw "temporary";
  } catch (reason) {
    const observed = reason;
  }
  return reason + 2;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("runs JavaScript finally before preserving a pending return value", async () => {
  const value = await compileAndRun(`
export function main() {
  let answer = 40;
  try {
    return answer;
  } finally {
    answer = 42;
  }
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 40 });
});

Deno.test("lets a JavaScript finally return override an earlier return", async () => {
  const value = await compileAndRun(`
export function main() {
  try {
    return 1;
  } finally {
    return 42;
  }
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("runs JavaScript finally while propagating a pending throw", async () => {
  const value = await compileAndRun(`
export function main() {
  try {
    try {
      throw 40;
    } finally {
      const observed = 2;
    }
  } catch (reason) {
    return reason + 2;
  }
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("lets a JavaScript finally throw override a pending return", async () => {
  const value = await compileAndRun(`
export function main() {
  try {
    try {
      return 1;
    } finally {
      throw 40;
    }
  } catch (reason) {
    return reason + 2;
  }
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("constructs standard JavaScript errors as catchable values", async () => {
  const value = await compileAndRun(`
export function main() {
  try {
    throw new TypeError("wrong type");
  } catch (reason) {
    return reason === reason ? 42 : 0;
  }
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("distinguishes standard JavaScript errors with instanceof", async () => {
  const value = await compileAndRun(`
export function main() {
  try {
    throw new TypeError("wrong type");
  } catch (reason) {
    return reason instanceof TypeError &&
      reason instanceof Error &&
      !(reason instanceof RangeError)
      ? 42
      : 0;
  }
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("preserves error identity across a throwing JavaScript call", async () => {
  const value = await compileAndRun(`
function fail() {
  throw new TypeError("wrong type");
}

export function main() {
  try {
    fail();
    return 0;
  } catch (reason) {
    return reason instanceof TypeError ? 42 : 0;
  }
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("treats primitive values as non-instances of JavaScript errors", async () => {
  const value = await compileAndRun(`
export function main() {
  return 42 instanceof TypeError ? 0 : 42;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("evaluates JavaScript strings and strict equality", async () => {
  const value = await compileAndRun(`
export function main() {
  const bird = "🦆";
  return bird === "\\u{1f986}";
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("concatenates statically known JavaScript primitive strings", async () => {
  const value = await compileAndRun(`
export function main() {
  return "answer:" + 42 === "answer:42" &&
    null + "!" === "null!" &&
    "enabled=" + true === "enabled=true";
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("concatenates a JavaScript string parameter with compound assignment", async () => {
  const value = await compileAndRun(`
function appendSuffix(value) {
  value += "BA";
  return value;
}

export function main() {
  return appendSuffix("AB") === "ABBA";
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("coerces a plain empty JavaScript object to NaN for numeric operators", async () => {
  const value = await compileAndRun(`
export function main() {
  return 1 * {} !== 1 && ({}) / 1 !== 1;
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("applies JavaScript loose equality to statically known primitives", async () => {
  const value = await compileAndRun(`
export function main() {
  return 42 == "42" &&
    0 == false &&
    null == undefined &&
    NaN != NaN &&
    null != 0;
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("applies JavaScript relational comparison to known primitive values", async () => {
  const value = await compileAndRun(`
export function main() {
  return "ab" < "abcd" && null >= false && undefined > null === false;
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("returns the selected JavaScript operand from literal logical expressions", async () => {
  const value = await compileAndRun(`
export function main() {
  return ("selected" || 0) === "selected" && (0 || 42) === 42;
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("applies JavaScript truthiness to function values and constant IIFEs", async () => {
  const value = await compileAndRun(`
export function main() {
  if (!function named() { return 0; }) return 0;
  if (function named() { return 0; }()) return 0;
  return 42;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("lowers JavaScript for loops and mutable bindings into recursive Core", async () => {
  const value = await compileAndRun(`
export function main() {
  let total = 0;
  for (let value = 1; value <= 6; value++) {
    total += value;
  }
  return total * 2;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("lowers var for headers and single-statement bodies", async () => {
  const value = await compileAndRun(`
export function main() {
  var total = 0;
  for (var value = 1; value <= 6; value++) total += value;
  return total * 2;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("supports omitted for fields and empty JavaScript statements", async () => {
  const value = await compileAndRun(`
export function main() {
  var value = 0;
  if (false);
  for (; value < 40; value++);
  for (var offset = 0; offset < 2;) offset++;
  return value + offset;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("preserves for updates across JavaScript continue and exits on break", async () => {
  const value = await compileAndRun(`
export function main() {
  var total = 0;
  for (var value = 0; value < 10; value++) {
    if (value === 2) continue;
    if (value === 5) break;
    total += value;
  }
  return total + 34;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("runs JavaScript finally before completing break and continue", async () => {
  const value = await compileAndRun(`
export function main() {
  var value = 0;
  var total = 0;
  while (value < 2) {
    try {
      value++;
      continue;
    } finally {
      total += 20;
    }
  }
  while (true) {
    try {
      break;
    } finally {
      total += 2;
    }
  }
  return total;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("eliminates the zero-iteration path for statically truthy JavaScript loops", async () => {
  const value = await compileAndRun(`
export function main() {
  var answer;
  while ({}) {
    answer = 42;
    break;
  }
  return answer;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("threads JavaScript assignments through both conditional loop branches", async () => {
  const value = await compileAndRun(`
export function main() {
  let index = 0;
  let total = 0;
  while (index < 5) {
    if (index === 2) {
      total += 10;
    } else {
      total += 1;
    }
    index++;
  }
  return total;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 14 });
});

Deno.test("preserves known JavaScript values through compound assignment", async () => {
  const value = await compileAndRun(`
export function main() {
  var value;
  value = null;
  value *= undefined;
  return isNaN(value);
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("converts JavaScript update operands to numbers before arithmetic", async () => {
  const value = await compileAndRun(`
export function main() {
  var numericText = "1";
  var invalidText = "duck";
  var wrapped = new Number("-1");
  numericText++;
  invalidText++;
  wrapped++;
  return numericText === 2 && isNaN(invalidText) && wrapped === 0;
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("emits JavaScript closures that capture lexical values", async () => {
  const value = await compileAndRun(`
function makeAdder(offset) {
  return function(value) {
    return value + offset;
  };
}

export function main() {
  const addTwo = makeAdder(2);
  return addTwo(40);
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("lowers single-parameter JavaScript arrows with expression and block bodies", async () => {
  const value = await compileAndRun(`
export function main() {
  const offset = 2;
  const addOffset = value => value + offset;
  const double = value => {
    return value * 2;
  };
  return double(addOffset(19));
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("calls zero-argument JavaScript function expressions through a hidden unit value", async () => {
  const value = await compileAndRun(`
export function main() {
  const answer = function() {
    return 42;
  };
  return answer();
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("runs a function expression whose thrown value is caught before returning", async () => {
  const value = await compileAndRun(`
export function main() {
  return function() {
    try {
      throw 40;
    } catch (reason) {
      return reason + 2;
    }
  }();
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("propagates a function expression throw into its caller's catch", async () => {
  const value = await compileAndRun(`
export function main() {
  try {
    return function() { throw 40; }();
  } catch (reason) {
    return reason + 2;
  }
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("propagates a named function throw into its caller's catch", async () => {
  const value = await compileAndRun(`
function fail() {
  throw 40;
}

export function main() {
  try {
    fail();
    return 0;
  } catch (reason) {
    return reason + 2;
  }
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("stops binary evaluation when the left JavaScript call throws", async () => {
  const value = await compileAndRun(`
function failLeft() {
  throw 40;
}

function failRight() {
  throw 0;
}

export function main() {
  try {
    return failLeft() + failRight();
  } catch (reason) {
    return reason + 2;
  }
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("keeps a named JavaScript function expression recursive and locally scoped", async () => {
  const value = await compileAndRun(`
export function main() {
  const factorial = function recurse(value) {
    if (value === 0) {
      return 1;
    }
    return value * recurse(value - 1);
  };
  return factorial(5) - 78;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("keeps a named JavaScript function expression name out of its outer scope", () => {
  const frontend = lowerJavaScriptAotSource(
    "named-function-scope.mjs",
    `export function main() { const local = function privateName(value) { return value; }; return privateName(42); }`,
  );
  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /name "privateName" is not lexically declared/);
});

Deno.test("lowers homogeneous JavaScript arrays to a generic Core algebraic type", async () => {
  const value = await compileAndRun(`
export function main() {
  const values = [10, 20, 12];
  return values[1] + values[2] - values.length + 13;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("runs JavaScript Array.map and Array.reduce as higher-order Core recursion", async () => {
  const value = await compileAndRun(`
export function main() {
  const scaled = [1, 2, 3].map(function(value) {
    return value * 2;
  });
  return scaled.reduce(function(total, value) {
    return total + value;
  }, 30);
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("evaluates JavaScript expression statements before the following return", async () => {
  const value = await compileAndRun(`
function requirePositive(value) {
  return value > 0;
}

export function main() {
  requirePositive(1);
  return 42;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("evaluates standard JavaScript radix literals and numeric separators", async () => {
  const value = await compileAndRun(`
export function main() {
  return 0x20 + 0b1000 + 0o2 + 1_000 / 1_000 - 1;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("preserves JavaScript floating-point remainder semantics", async () => {
  const value = await compileAndRun(`
export function main() {
  const zeroDivisor = 5 % 0;
  const infiniteDividend = Infinity % 5;
  return 85.5 % 43.5 === 42 &&
    -5 % 2 === -1 &&
    1 / (-1 % 1) === Number.NEGATIVE_INFINITY &&
    1 / (1 % -1) === Number.POSITIVE_INFINITY &&
    5 % -2 === 1 &&
    5 % Infinity === 5 &&
    zeroDivisor !== zeroDivisor &&
    infiniteDividend !== infiniteDividend;
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("applies JavaScript bitwise coercion and operator precedence", async () => {
  const value = await compileAndRun(`
export function main() {
  return ~0 === -1 &&
    (1 | 2 ^ 3 & 1) === 3 &&
    (1 << 4 + 1) === 32 &&
    (-8 >> 2) === -2 &&
    (-1 >>> 0) === 4294967295
    ? 42
    : 0;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("retains constants through JavaScript bitwise compound assignments", async () => {
  const value = await compileAndRun(`
export function main() {
  var value = 8;
  value >>>= 2;
  value <<= 4;
  value |= 10;
  value ^= 3;
  value &= 15;
  value %= 7;
  return value * 21;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("provides the immutable JavaScript NaN and Infinity globals", async () => {
  const value = await compileAndRun(`
export function main() {
  return NaN !== NaN && Infinity > 1;
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("evaluates static isNaN coercion and standard Number constants", async () => {
  const value = await compileAndRun(`
export function main() {
  return isNaN(undefined) && isNaN("duck") && !isNaN(null) &&
    isNaN(Number.NaN + 1) &&
    Number.POSITIVE_INFINITY === Infinity && Number.NEGATIVE_INFINITY < 0 &&
    Number.MAX_VALUE > Number.MIN_VALUE && Number.NaN !== Number.NaN;
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("coerces statically known primitive wrapper objects without erasing their identity", async () => {
  const value = await compileAndRun(`
export function main() {
  return new Boolean(true) + true === 2 &&
    new Number(40) + 2 === 42 &&
    new String("duck") + "!" === "duck!" &&
    isNaN(new Number(NaN)) &&
    new Number(1) == 1 &&
    new Number(1) !== 1 &&
    new Boolean(true) != new Boolean(true);
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("retains JavaScript primitive wrapper semantics after binding", async () => {
  const value = await compileAndRun(`
export function main() {
  const boxedFalse = new Boolean(false);
  const boxedForty = new Number(40);
  const boxedText = new String("duck");
  return boxedFalse && boxedFalse === boxedFalse &&
    boxedFalse !== new Boolean(false) &&
    boxedForty + 2 === 42 && boxedText + "!" === "duck!" &&
    typeof boxedForty === "object";
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("folds literal truthiness before unifying unreachable JavaScript branches", async () => {
  const value = await compileAndRun(`
export function main() {
  return true ? 42 : false;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("applies JavaScript ToNumber to a string literal under unary minus", async () => {
  const value = await compileAndRun(`
export function main() {
  return -"";
}
`);

  deepStrictEqual(value, { kind: "float-64", value: -0 });
});

Deno.test("evaluates JavaScript unary coercion and statically known typeof results", async () => {
  const value = await compileAndRun(`
export function main() {
  return typeof missing === "undefined" &&
    typeof function(value) { return value; } === "function" &&
    typeof {} === "object" &&
    typeof null === "object" &&
    typeof 1 === "number" &&
    typeof "" === "string" &&
    typeof true === "boolean" &&
    +"" === 0 &&
    +true === 1 &&
    +null === 0 &&
    void 42 === undefined;
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("distinguishes JavaScript null and undefined values", async () => {
  const value = await compileAndRun(`
export function main() {
  return null !== undefined && null === null && undefined === undefined;
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("returns JavaScript undefined from a function that completes normally", async () => {
  const value = await compileAndRun(`
function complete(value) {
  if (value) {
    return undefined;
  }
}

export function main() {
  return complete(false);
}
`);

  deepStrictEqual(value, {
    kind: "constructor",
    name: "$JavaScriptUndefined",
    fields: [],
  });
});

Deno.test("supports a bare JavaScript return statement", async () => {
  const value = await compileAndRun(`
export function main() {
  return;
}
`);

  deepStrictEqual(value, {
    kind: "constructor",
    name: "$JavaScriptUndefined",
    fields: [],
  });
});

Deno.test("inserts a JavaScript semicolon when return is followed by a line terminator", async () => {
  const value = await compileAndRun(`
function ignoredExpression() {
  return
  41;
}

export function main() {
  return ignoredExpression() === undefined ? 42 : 0;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("inserts JavaScript semicolons at eligible statement boundaries", async () => {
  const value = await compileAndRun(`
export function main() {
  let answer = 40
  answer += 2
  answer
  return answer
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("rejects a missing JavaScript semicolon without an ASI boundary", () => {
  const frontend = lowerJavaScriptAotSource(
    "missing-semicolon.mjs",
    "export function main() { const answer = 42 return answer; }",
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /Unexpected token \"return\"/);
});

Deno.test("hoists JavaScript var bindings and initializes them to undefined", async () => {
  const value = await compileAndRun(`
export function main() {
  return value;
  var value = 42;
}
`);

  deepStrictEqual(value, {
    kind: "constructor",
    name: "$JavaScriptUndefined",
    fields: [],
  });
});

Deno.test("evaluates repeated JavaScript var initializers in source order", async () => {
  const value = await compileAndRun(`
export function main() {
  var value = 1, value = value + 1;
  if (true) {
    var value = value + 40;
  }
  return value;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("folds indexed access and length for a known JavaScript string", async () => {
  const value = await compileAndRun(`
export function main() {
  var value = "66\\u2028123";
  return value === "66\\u2028123" && value[2] === "\\u2028" && value.length === 6;
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("lowers JavaScript object key forms and applies ordered duplicate overwrites", async () => {
  const value = await compileAndRun(`
export function main() {
  const x = 1;
  const point = { x, "answer": 40, 2: 2, answer: 41 };
  return point.answer + point["2"] - point.x;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("accepts trailing commas in JavaScript parameters, calls, arrays, and objects", async () => {
  const value = await compileAndRun(`
function add(left, right,) {
  return left + right;
}

export function main() {
  const point = { x: 40, y: 2, };
  const values = [point.x, point.y,];
  return add(values[0], values[1],);
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("hoists local JavaScript function declarations before their source position", async () => {
  const value = await compileAndRun(`
export function main() {
  return answer();

  function answer() {
    return 42;
  }
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("lowers mutually recursive local JavaScript declarations as one recursive group", async () => {
  const value = await compileAndRun(`
export function main() {
  function even(value) {
    if (value === 0) {
      return true;
    }
    return odd(value - 1);
  }

  function odd(value) {
    if (value === 0) {
      return false;
    }
    return even(value - 1);
  }

  return even(42);
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("keeps block-level JavaScript function declarations inside their lexical scope", async () => {
  const value = await compileAndRun(`
function choose(value) {
  return value + 1;
}

export function main() {
  let result = choose(40);
  {
    function choose(value) {
      return value + 2;
    }
    result += choose(0);
  }
  return result - 1;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("rejects malformed JavaScript numeric separators during parsing", () => {
  const frontend = lowerJavaScriptAotSource(
    "numeric-separator.mjs",
    `export function main() { return 1__0; }`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  equal(frontend.diagnostics[0].code, "J1001");
});

Deno.test("rejects dynamic JavaScript code generation before GPU compilation", () => {
  const frontend = lowerJavaScriptAotSource(
    "dynamic-code.mjs",
    `export function main() { return eval("40 + 2"); }`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  equal(frontend.diagnostics[0].code, "J1002");
  match(frontend.diagnostics[0].message, /forbids dynamic code generation through "eval"/);

  const constructor = lowerJavaScriptAotSource(
    "function-constructor.mjs",
    `export function main() { return new Function("return 42"); }`,
  );
  equal(constructor.ok, false);
  if (constructor.ok) return;
  match(constructor.diagnostics[0].message, /forbids dynamic code generation through new Function/);
});

Deno.test("rejects top-level constants that read a later lexical binding", () => {
  const frontend = lowerJavaScriptAotSource(
    "temporal-dead-zone.mjs",
    `export const main = answer; const answer = 42;`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /name "answer" is not lexically declared/);
});

Deno.test("reports direct JavaScript calls that omit required arguments", () => {
  const frontend = lowerJavaScriptAotSource(
    "arity.mjs",
    `function add(left, right) { return left + right; } export function main() { return add(42); }`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /function "add" expects 2 arguments.*supplies 1/);
});

Deno.test("rejects assignment to a JavaScript const binding", () => {
  const frontend = lowerJavaScriptAotSource(
    "const-assignment.mjs",
    `export function main() { const answer = 40; answer += 2; return answer; }`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /cannot replace immutable binding "answer"/);
});

Deno.test("reports unsupported JavaScript array callback arity before inference", () => {
  const frontend = lowerJavaScriptAotSource(
    "map-index.mjs",
    `export function main() { return [40].map(function(value, index) { return value + index; })[0]; }`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /Array\.map callback expects 1 parameter.*declares 2/);
});

Deno.test("rejects mutable closure cells until their state model is explicit", () => {
  const frontend = lowerJavaScriptAotSource(
    "captured-mutation.mjs",
    `export function main() { let value = 40; const add = function(offset) { value += offset; return value; }; return add(2); }`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /closure assignment to captured binding "value"/);
});

Deno.test("rejects snapshot lowering when a closure reads a later-mutated binding", () => {
  const frontend = lowerJavaScriptAotSource(
    "mutable-capture.mjs",
    `export function main() { let value = 40; const read = function(unit) { return value; }; value += 2; return read(0); }`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /closure reads captured mutable binding "value"/);
});

async function compileAndRun(source: string) {
  const frontend = lowerJavaScriptAotSource("test.mjs", source);
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) throw new Error("JavaScript source did not lower");
  if (compiler === undefined) throw new Error("JavaScript AOT test compiler was not initialized");

  const compilation = await compiler.compileModule(frontend.lowered.module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("JavaScript AOT module did not compile");
  try {
    return (await runFunctionalWasmModule(compilation.module)).value;
  } finally {
    compilation.module.destroy();
  }
}
