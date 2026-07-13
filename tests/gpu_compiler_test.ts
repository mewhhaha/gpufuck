import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";

import {
  BrainfuckOpcode,
  GpuBrainfuckCompiler,
  MAXIMUM_SOURCE_BYTE_LENGTH,
  requestWebGpuDevice,
} from "../mod.ts";

type ExpectedInstruction = Readonly<{
  opcode: BrainfuckOpcode;
  operand: number;
}>;

async function withCompiler(
  test: (compiler: GpuBrainfuckCompiler) => Promise<void>,
): Promise<void> {
  const device = await requestWebGpuDevice();

  try {
    await test(await GpuBrainfuckCompiler.create(device));
  } finally {
    device.destroy();
  }
}

async function compileInstructions(
  compiler: GpuBrainfuckCompiler,
  source: string,
): Promise<readonly ExpectedInstruction[]> {
  const result = await compiler.compile(source);
  ok(result.ok, `expected ${JSON.stringify(source)} to compile successfully`);

  try {
    return await result.ir.readInstructions();
  } finally {
    result.ir.destroy();
  }
}

function instructions(
  opcodes: readonly BrainfuckOpcode[],
): readonly ExpectedInstruction[] {
  return opcodes.map((opcode) => ({ opcode, operand: 0 }));
}

Deno.test("compiles every Brainfuck command and preserves ignored bytes as NOP", async () => {
  await withCompiler(async (compiler) => {
    const actual = await compileInstructions(compiler, "><+-.,[]x");

    deepStrictEqual(actual, [
      ...instructions([
        BrainfuckOpcode.Right,
        BrainfuckOpcode.Left,
        BrainfuckOpcode.Increment,
        BrainfuckOpcode.Decrement,
        BrainfuckOpcode.Output,
        BrainfuckOpcode.Input,
      ]),
      { opcode: BrainfuckOpcode.LoopStart, operand: 8 },
      { opcode: BrainfuckOpcode.LoopEnd, operand: 7 },
      { opcode: BrainfuckOpcode.NOP, operand: 0 },
    ]);
  });
});

Deno.test("compiles nested loops and comments with absolute next-program-counter targets", async () => {
  await withCompiler(async (compiler) => {
    const actual = await compileInstructions(compiler, "[a[b]c]");

    deepStrictEqual(actual, [
      { opcode: BrainfuckOpcode.LoopStart, operand: 7 },
      { opcode: BrainfuckOpcode.NOP, operand: 0 },
      { opcode: BrainfuckOpcode.LoopStart, operand: 5 },
      { opcode: BrainfuckOpcode.NOP, operand: 0 },
      { opcode: BrainfuckOpcode.LoopEnd, operand: 3 },
      { opcode: BrainfuckOpcode.NOP, operand: 0 },
      { opcode: BrainfuckOpcode.LoopEnd, operand: 1 },
    ]);
  });
});

Deno.test("reports an unmatched closing bracket at its UTF-8 source byte", async () => {
  await withCompiler(async (compiler) => {
    const result = await compiler.compile("é]");

    equal(result.ok, false);
    if (result.ok) return;

    equal(result.diagnostic.kind, "unmatched-closing-bracket");
    equal(result.diagnostic.code, "E1001");
    equal(result.diagnostic.sourceByteOffset, 2);
  });
});

Deno.test("reports an unmatched outer opening bracket", async () => {
  await withCompiler(async (compiler) => {
    const result = await compiler.compile("[[]");

    equal(result.ok, false);
    if (result.ok) return;

    equal(result.diagnostic.kind, "unmatched-opening-bracket");
    equal(result.diagnostic.code, "E1002");
    equal(result.diagnostic.sourceByteOffset, 0);
  });
});

Deno.test("compiles empty and comment-only sources into source-aligned NOP IR", async () => {
  await withCompiler(async (compiler) => {
    deepStrictEqual(await compileInstructions(compiler, ""), []);
    deepStrictEqual(
      await compileInstructions(compiler, "hello world"),
      instructions([
        BrainfuckOpcode.NOP,
        BrainfuckOpcode.NOP,
        BrainfuckOpcode.NOP,
        BrainfuckOpcode.NOP,
        BrainfuckOpcode.NOP,
        BrainfuckOpcode.NOP,
        BrainfuckOpcode.NOP,
        BrainfuckOpcode.NOP,
        BrainfuckOpcode.NOP,
        BrainfuckOpcode.NOP,
        BrainfuckOpcode.NOP,
      ]),
    );
    deepStrictEqual(
      await compileInstructions(compiler, "é"),
      instructions([BrainfuckOpcode.NOP, BrainfuckOpcode.NOP]),
    );
  });
});

Deno.test("reads commands at each packed source-word boundary", async () => {
  await withCompiler(async (compiler) => {
    const actual = await compileInstructions(compiler, "abc>def<ghi+jkl-");

    deepStrictEqual(actual, [
      ...instructions([
        BrainfuckOpcode.NOP,
        BrainfuckOpcode.NOP,
        BrainfuckOpcode.NOP,
      ]),
      { opcode: BrainfuckOpcode.Right, operand: 0 },
      ...instructions([
        BrainfuckOpcode.NOP,
        BrainfuckOpcode.NOP,
        BrainfuckOpcode.NOP,
      ]),
      { opcode: BrainfuckOpcode.Left, operand: 0 },
      ...instructions([
        BrainfuckOpcode.NOP,
        BrainfuckOpcode.NOP,
        BrainfuckOpcode.NOP,
      ]),
      { opcode: BrainfuckOpcode.Increment, operand: 0 },
      ...instructions([
        BrainfuckOpcode.NOP,
        BrainfuckOpcode.NOP,
        BrainfuckOpcode.NOP,
      ]),
      { opcode: BrainfuckOpcode.Decrement, operand: 0 },
    ]);
  });
});

Deno.test("rejects readback after the exposed IR buffer is destroyed", async () => {
  await withCompiler(async (compiler) => {
    const result = await compiler.compile("+");
    ok(result.ok);

    result.ir.buffer.destroy();
    try {
      await rejects(
        () => result.ir.readInstructions(),
        /WebGPU rejected Brainfuck IR readback/,
      );
    } finally {
      result.ir.destroy();
    }
  });
});

Deno.test("accepts the source limit and rejects the next byte", async () => {
  await withCompiler(async (compiler) => {
    const maximumSource = "x".repeat(MAXIMUM_SOURCE_BYTE_LENGTH);
    const maximumResult = await compiler.compile(maximumSource);
    ok(maximumResult.ok);
    try {
      equal(maximumResult.ir.instructionCount, MAXIMUM_SOURCE_BYTE_LENGTH);
    } finally {
      maximumResult.ir.destroy();
    }

    const sourceByteLength = maximumSource.length + 1;
    const oversizedResult = await compiler.compile(`${maximumSource}x`);

    equal(oversizedResult.ok, false);
    if (oversizedResult.ok) return;

    equal(oversizedResult.diagnostic.kind, "source-too-large");
    equal(oversizedResult.diagnostic.code, "E1003");
    if (oversizedResult.diagnostic.kind !== "source-too-large") return;
    equal(oversizedResult.diagnostic.sourceByteLength, sourceByteLength);
    equal(oversizedResult.diagnostic.maximumSourceByteLength, MAXIMUM_SOURCE_BYTE_LENGTH);
  });
});
