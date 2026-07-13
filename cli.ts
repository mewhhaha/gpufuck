import { brainfuckOpcodeName, GpuBrainfuckCompiler, requestWebGpuDevice } from "./mod.ts";

async function main(arguments_: readonly string[]): Promise<number> {
  const sourcePath = arguments_[0];
  if (arguments_.length !== 1 || sourcePath === undefined) {
    console.error("usage: deno task compile <source.bf>");
    return 2;
  }

  let source: string;
  try {
    source = await Deno.readTextFile(sourcePath);
  } catch (cause) {
    const reason = cause instanceof Error ? `: ${cause.message}` : "";
    throw new Error(
      `could not read Brainfuck source ${JSON.stringify(sourcePath)}${reason}`,
      { cause },
    );
  }

  const device = await requestWebGpuDevice();
  try {
    const compiler = await GpuBrainfuckCompiler.create(device);
    const result = await compiler.compile(source);
    if (!result.ok) {
      console.error(`error[${result.diagnostic.code}]: ${result.diagnostic.message}`);
      return 1;
    }

    try {
      const instructions = await result.ir.readInstructions();
      console.log(JSON.stringify(
        {
          instructionCount: result.ir.instructionCount,
          instructions: instructions.map((instruction, sourceByteOffset) => ({
            sourceByteOffset,
            opcode: brainfuckOpcodeName(instruction.opcode),
            operand: instruction.operand,
          })),
        },
        null,
        2,
      ));
      return 0;
    } finally {
      result.ir.destroy();
    }
  } finally {
    device.destroy();
  }
}

if (import.meta.main) {
  try {
    Deno.exitCode = await main(Deno.args);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`error: ${message}`);
    Deno.exitCode = 1;
  }
}
