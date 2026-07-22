import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";

import {
  GpuFunctionalCompiler,
  requestWebGpuDevice,
  runFunctionalWasmModule,
} from "../functional.ts";
import { lowerJavaScriptAotSource } from "../examples/javascript-aot/mod.ts";
import { parseJavaScriptAotModule } from "../examples/javascript-aot/src/parser.ts";
import { lowerJavaScriptRuntimeModule } from "../examples/javascript-aot/src/runtime_lowering.ts";

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

Deno.test("constructs an ordinary object with the standard Object constructor", async () => {
  const value = await compileAndRun(`
export function main() {
  const object = new Object();
  object.answer = 42;
  return object.answer === 42;
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("checks own properties without consulting the prototype chain", async () => {
  const value = await compileAndRun(`
export function main() {
  const object = new Object();
  object.answer = 42;
  return object.hasOwnProperty("answer") && !object.hasOwnProperty("missing") ? 42 : 0;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("coerces numeric literal property keys for static and runtime objects", async () => {
  const staticValue = await compileAndRun(`
export function main() {
  const values = { 5: 42 };
  return values[5];
}
`);
  const runtimeValue = await compileAndRun(`
export function main() {
  const values = {};
  values[5] = 42;
  return values[5] + 0;
}
`);

  deepStrictEqual(staticValue, { kind: "float-64", value: 42 });
  deepStrictEqual(runtimeValue, { kind: "float-64", value: 42 });
});

Deno.test("invokes JavaScript accessors with their property receiver", async () => {
  const value = await compileAndRun(`
export function main() {
  const object = { stored: 40 };
  Object.defineProperty(object, "answer", {
    get: function() { return this.stored; },
    set: function(value) { this.stored = value; },
    enumerable: true,
    configurable: true
  });
  object.answer = 42;
  return object.answer + 0;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("propagates a JavaScript getter throw through lexical catch", async () => {
  const value = await compileAndRun(`
export function main() {
  const object = {};
  Object.defineProperty(object, "answer", {
    get: function() { throw 42; }
  });
  try {
    return object.answer + 0;
  } catch (error) {
    return error + 0;
  }
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("propagates a JavaScript setter throw through lexical catch", async () => {
  const value = await compileAndRun(`
export function main() {
  const object = {};
  Object.defineProperty(object, "answer", {
    set: function(value) { throw value; }
  });
  try {
    object.answer = 42;
    return 0;
  } catch (error) {
    return error + 0;
  }
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("returns undefined when a JavaScript accessor has no getter", async () => {
  const value = await compileAndRun(`
export function main() {
  const object = {};
  Object.defineProperty(object, "answer", {
    set: function(value) { this.value = value; }
  });
  return object.answer === undefined;
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("rejects assignment through a JavaScript accessor without a setter", async () => {
  await rejects(
    () =>
      compileAndRun(`
export function main() {
  const object = {};
  Object.defineProperty(object, "answer", {
    get: function() { return 42; }
  });
  object.answer = 0;
  return 0;
}
`),
    /property "answer" has no setter/,
  );
});

Deno.test("rejects a non-callable JavaScript accessor at definition", async () => {
  await rejects(
    () =>
      compileAndRun(`
export function main() {
  const object = {};
  Object.defineProperty(object, "answer", { get: 42 });
  return 0;
}
`),
    /descriptor "get" must be callable or undefined/,
  );
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

Deno.test("binds undefined as this for an ordinary strict JavaScript call", async () => {
  const value = await compileAndRun(`
export function main() {
  const readThis = function() { return this; };
  if (function() {} === function() {}) return false;
  return readThis() === undefined;
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("binds the receiver as this for a JavaScript method call", async () => {
  const value = await compileAndRun(`
export function main() {
  const object = {
    answer: 40,
    readAnswer: function(offset) { return this.answer + offset; }
  };
  if (function() {} === function() {}) return 0;
  return object.readAnswer(2) + 0;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("parses object method syntax into receiver-aware callable properties", async () => {
  const value = await compileAndRun(`
export function main() {
  const counter = {
    value: 40,
    add(offset) { return this.value + offset; }
  };
  if (function() {} === function() {}) return 0;
  return counter.add(2) + 0;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("applies callee strictness through Function.prototype call and apply", async () => {
  const value = await compileAndRun(
    `
export function main() {
  var global = this;
  const strictThis = function() {
    "use strict";
    return this;
  };
  const sloppyThis = function() { return this; };
  if (function() {} === function() {}) return false;
  return strictThis.call(undefined) === undefined &&
    sloppyThis.call(undefined) === global &&
    strictThis.apply(null) === null &&
    sloppyThis.apply() === global;
}
`,
    { callThisMode: "sloppy" },
  );

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("binds this once while preserving the target function strictness", async () => {
  const value = await compileAndRun(
    `
export function main() {
  var global = this;
  const strictThis = function() {
    "use strict";
    return this;
  };
  const sloppyThis = function() { return this; };
  const object = {};
  return strictThis.bind(null)() === null &&
    sloppyThis.bind(undefined)() === global &&
    strictThis.bind(object).call(global) === object;
}
`,
    { callThisMode: "sloppy" },
  );

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("invokes a String replace callback with its callee strictness", async () => {
  const value = await compileAndRun(
    `
export function main() {
  let callbackThis = 0;
  const replace = function(match) {
    "use strict";
    callbackThis = this;
    return "a";
  };
  if (function() {} === function() {}) return false;
  return "ab".replace("b", replace) === "aa" && callbackThis === undefined;
}
`,
    { callThisMode: "sloppy" },
  );

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("captures lexical this for a JavaScript arrow function", async () => {
  const value = await compileAndRun(`
export function main() {
  const source = {
    answer: 42,
    makeReader: function() {
      return unused => this.answer;
    }
  };
  const readAnswer = source.makeReader();
  const other = { answer: 0, readAnswer: readAnswer };
  if (function() {} === function() {}) return 0;
  return other.readAnswer(0) + 0;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("shares the Realm global object between a sloppy script and ordinary call", async () => {
  const value = await compileAndRun(
    `
export function main() {
  var global = this;
  const writeAnswer = function() { this.answer = 42; };
  if (function() {} === function() {}) return 0;
  writeAnswer();
  return global.answer + 0;
}
`,
    { callThisMode: "sloppy" },
  );

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("binds the Realm global object as this for a strict Test262 script", async () => {
  const value = await compileAndRun(
    `
export function main() {
  return this !== undefined;
}
`,
    { callThisMode: "strict", entryThisMode: "global" },
  );

  deepStrictEqual(value, { kind: "boolean", value: true });
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

Deno.test("executes twelve sequential runtime method calls", async () => {
  const value = await compileAndRun(`
function increment(value) {
  return value + 1;
}

export function main() {
  let holder = {};
  holder.increment = increment;
  let value = 0;
  value = holder.increment(value);
  value = holder.increment(value);
  value = holder.increment(value);
  value = holder.increment(value);
  value = holder.increment(value);
  value = holder.increment(value);
  value = holder.increment(value);
  value = holder.increment(value);
  value = holder.increment(value);
  value = holder.increment(value);
  value = holder.increment(value);
  value = holder.increment(value);
  return value;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 12 });
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

Deno.test("creates an arguments object with actual values and length", async () => {
  const value = await compileAndRun(`
export function main() {
  const inspect = function(first) {
    return arguments.length === 2 && arguments["0"] === first && arguments["1"] === 39;
  };
  if (function() {} === function() {}) return false;
  return inspect(42, 39) === true;
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("reflects sloppy parameter writes through mapped arguments", async () => {
  const value = await compileAndRun(
    `
function update(value) {
  value = 42;
  return arguments[0];
}

export function main() {
  return update(0) === 42;
}
`,
    { callThisMode: "sloppy" },
  );

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("reflects mapped argument writes through sloppy parameters", async () => {
  const value = await compileAndRun(
    `
function update(value) {
  arguments[0] = 42;
  return value;
}

export function main() {
  return update(0) === 42;
}
`,
    { callThisMode: "sloppy" },
  );

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("exposes function length without counting a trailing comma", async () => {
  const value = await compileAndRun(`
export function main() {
  const pair = function(first, second,) { return first; };
  if (function() {} === function() {}) return false;
  return pair.length === 2;
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("folds the length of a statically known function", async () => {
  const value = await compileAndRun(`
function pair(first, second) { return first; }
function withDefault(first, second = 0) { return first; }
export function main() { return pair.length + withDefault.length + 39; }
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("evaluates default parameters only for missing or undefined arguments", async () => {
  const value = await compileAndRun(`
export function main() {
  let defaults = 0;
  const defaultValue = function() {
    defaults = defaults + 1;
    return 2;
  };
  const add = function(first, second = defaultValue()) {
    "use strict";
    return first + second;
  };
  const calculator = {
    add(first, second = 2) { return first + second; }
  };
  if (function() {} === function() {}) return false;
  return add.length === 1 &&
    add(40, 1) === 41 &&
    defaults === 0 &&
    add(40, undefined) === 42 &&
    defaults === 1 &&
    calculator.add(40) === 42;
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("binds object, array, and rest parameters from actual arguments", async () => {
  const value = await compileAndRun(`
export function main() {
  const combine = function({ left, right: renamed }, [third, fourth]) {
    return left + renamed + third + fourth;
  };
  const total = function(...values) {
    return values.length === 3
      ? values["0"] + values["1"] + values["2"]
      : 0;
  };
  return combine({ left: 10, right: 20 }, [5, 7]) + total(10, 20, 12) - 42;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("constructs a top-level class and invokes its instance methods", async () => {
  const value = await compileAndRun(`
class Counter {
  constructor(value = 40) {
    this.value = value;
  }

  add(offset = 2) {
    return this.value + offset;
  }
}

export function main() {
  const counter = new Counter();
  return counter.add() + 0;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("shares class methods through the constructor prototype", async () => {
  const value = await compileAndRun(`
class Counter {
  read() {
    return 42;
  }
}

export function main() {
  const first = new Counter();
  return first.read === Counter.prototype.read;
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("tests class instances through the prototype chain", async () => {
  const value = await compileAndRun(`
class Counter {}

export function main() {
  const counter = new Counter();
  return counter instanceof Counter;
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("applies strict parameter rules to class methods", () => {
  const result = lowerJavaScriptAotSource(
    "strict-class-method.mjs",
    `class Invalid { method(value, value) { return value; } }
export function main() { return 42; }`,
  );

  equal(result.ok, false);
  if (result.ok) return;
  match(
    result.diagnostics[0].message,
    /strict mode function declares parameter "value" more than once/,
  );
});

Deno.test("keeps a class binding uninitialized until its declaration", async () => {
  await rejects(
    () =>
      compileAndRun(`
export function main() {
  const constructor = Counter;
  class Counter {}
  return constructor === Counter;
}
`),
    /ReferenceError: JavaScript name "Counter" was read before initialization/,
  );
});

Deno.test("resumes a straight-line generator through persistent iterator state", async () => {
  const value = await compileAndRun(`
function * sequence() {
  yield 42;
}

function verify(iterator, first) {
  const current = iterator.next();
  if (first) {
    if (current.done || current.value !== 42) return 0;
    return verify(iterator, false);
  }
  return current.done ? 42 : 0;
}

export function main() {
  return verify(sequence(), true) + 0;
}
`);

  deepStrictEqual(value, { kind: "float-64", value: 42 });
});

Deno.test("unwraps deterministic async values and invokes their then callback", async () => {
  const value = await compileAndRun(`
async function base() {
  return 40;
}

async function answer() {
  const value = await base();
  return value + 2;
}

export function main() {
  let observed = 0;
  answer().then(function(value) {
    observed = value;
    return value;
  });
  return observed + 0;
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

Deno.test("rejects runtime-model finally before expanding callable dispatch", async () => {
  await rejects(
    () =>
      compileAndRun(`
export function main() {
  const state = {};
  state.answer = 0;
  const read = function() {
    try {
      return 0;
    } finally {
      return 42;
    }
  };
  return state.answer === 0 ? read() : 0;
}
`),
    /runtime-model finally completion replacement is not yet supported/,
  );
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

Deno.test("evaluates runtime typeof for ordinary and callable objects", async () => {
  const value = await compileAndRun(`
export function main() {
  const object = {};
  const callable = function() {};
  return typeof object === "object" &&
    typeof callable === "function" &&
    typeof null === "object";
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("coerces dynamic primitive operands for arithmetic and string addition", async () => {
  const value = await compileAndRun(`
export function main() {
  const values = { truth: true, left: "gpu", right: "fuck" };
  if (function() {} === function() {}) return false;
  return +values.truth + null === 1 && values.left + values.right === "gpufuck";
}
`);

  deepStrictEqual(value, { kind: "boolean", value: true });
});

Deno.test("calls valueOf and toString in order for runtime numeric comparison", async () => {
  const value = await compileAndRun(`
export function main() {
  let accessed = false;
  const left = {
    valueOf: function() {
      accessed = true;
      return 3;
    }
  };
  const right = { toString: function() { return 4; } };
  if (function() {} === function() {}) return false;
  return left < right && accessed;
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

Deno.test("converts an uninitialized var before postfix increment", async () => {
  const value = await compileAndRun(`
export function main() {
  var value;
  value++;
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

Deno.test("bounds repeated JavaScript automatic semicolon insertion", () => {
  const declarations = Array.from(
    { length: 5 },
    (_, index) => `let value${index} = ${index}`,
  ).join("\n");
  const frontend = lowerJavaScriptAotSource(
    "automatic-semicolon-limit.mjs",
    `export function main() {\n${declarations}\nreturn 0;\n}`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(
    frontend.diagnostics[0].message,
    /requires more than 4 automatic semicolon insertions/,
  );
});

Deno.test("bounds JavaScript token streams before generated-parser work explodes", () => {
  const declarations = Array.from(
    { length: 1_700 },
    (_, index) => `let value${index} = ${index};`,
  ).join("");
  const frontend = lowerJavaScriptAotSource(
    "token-limit.mjs",
    `export function main() { ${declarations} return 0; }`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /exceeds the 8192-token parser limit/);
});

Deno.test("JavaScript token limits do not reject a large literal", () => {
  const literal = "x".repeat(20_000);
  const module = parseJavaScriptAotModule(
    "large-literal.mjs",
    `export function main() { return "${literal}"; }`,
  );

  equal(module.declarations.length, 1);
});

Deno.test("bounds JavaScript source bytes before allocating parser state", () => {
  const frontend = lowerJavaScriptAotSource(
    "source-limit.mjs",
    `/*${"x".repeat(256 * 1024)}*/`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /exceeds the 262144-byte source limit/);
});

Deno.test("JavaScript source bytes are accepted at the parser boundary", () => {
  const prefix = 'export function main() { return "';
  const suffix = '"; }';
  const source = `${prefix}${"x".repeat(256 * 1024 - prefix.length - suffix.length)}${suffix}`;
  const module = parseJavaScriptAotModule("source-boundary.mjs", source);

  equal(module.declarations.length, 1);
});

Deno.test("bounds JavaScript delimiter nesting before parser recursion overflows", () => {
  const frontend = lowerJavaScriptAotSource(
    "delimiter-depth.mjs",
    `export function main() { return ${"(".repeat(512)}0${")".repeat(512)}; }`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /exceeds the syntax nesting limit of 256/);
});

Deno.test("bounds JavaScript prefix operators before parser recursion overflows", () => {
  const frontend = lowerJavaScriptAotSource(
    "prefix-depth.mjs",
    `export function main() { return ${"!".repeat(2_048)}true; }`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /exceeds the prefix-operator nesting limit of 256/);
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

Deno.test("runtime-model lowering accepts programs beyond its former syntax budget", () => {
  const frontend = lowerJavaScriptAotSource(
    "runtime-syntax-scale.mjs",
    `export function main() { const object = {}; ${"0;".repeat(80)} return 42; }`,
  );

  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
});

Deno.test("runtime-model lowering joins sequential conditional expressions", () => {
  const frontend = lowerJavaScriptAotSource(
    "runtime-branch-scale.mjs",
    `export function main() { const object = {}; let flag = true; ${
      "flag = flag ? true : false; flag = flag && true;".repeat(16)
    } ${"try { 0; } catch { 0; }".repeat(16)} return 42; }`,
  );

  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
});

Deno.test("AOT lowering accepts try continuations at its recursion boundary", () => {
  const frontend = lowerJavaScriptAotSource(
    "try-continuation-boundary.mjs",
    `export function main() { let value = 0; ${
      "try { value += 1; } finally { value += 0; }".repeat(128)
    } return value; }`,
  );

  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
});

Deno.test("AOT lowering bounds sequential try continuation recursion", () => {
  const frontend = lowerJavaScriptAotSource(
    "try-continuation-limit.mjs",
    `export function main() { let value = 0; ${
      "try { value += 1; } finally { value += 0; }".repeat(129)
    } return value; }`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /try continuation nesting exceeds the limit of 128/);
});

Deno.test("flat JavaScript declarations stop at the surface depth boundary", () => {
  const declarations = Array.from(
    { length: 1_050 },
    (_, index) => `let value${index} = 0;`,
  ).join("");
  const frontend = lowerJavaScriptAotSource(
    "declaration-depth.mjs",
    `export function main() { ${declarations} return 0; }`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /functional surface expression exceeds depth 1024/);
});

async function compileAndRun(
  source: string,
  options: {
    readonly callThisMode?: "strict" | "sloppy";
    readonly entryThisMode?: "undefined" | "global";
  } = {},
) {
  let module;
  if (options.callThisMode !== undefined || options.entryThisMode !== undefined) {
    module = lowerJavaScriptRuntimeModule(
      parseJavaScriptAotModule("test.mjs", source),
      "main",
      options,
    ).module;
  } else {
    const frontend = lowerJavaScriptAotSource("test.mjs", source);
    ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
    if (!frontend.ok) throw new Error("JavaScript source did not lower");
    module = frontend.lowered.module;
  }
  if (compiler === undefined) throw new Error("JavaScript AOT test compiler was not initialized");

  const compilation = await compiler.compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("JavaScript AOT module did not compile");
  try {
    return (await runFunctionalWasmModule(compilation.module)).value;
  } finally {
    compilation.module.destroy();
  }
}
