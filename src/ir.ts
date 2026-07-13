export const BrainfuckOpcode = {
  NOP: 0,
  Right: 1,
  Left: 2,
  Increment: 3,
  Decrement: 4,
  Output: 5,
  Input: 6,
  LoopStart: 7,
  LoopEnd: 8,
} as const;

export type BrainfuckOpcode = (typeof BrainfuckOpcode)[keyof typeof BrainfuckOpcode];

export interface BrainfuckInstruction {
  readonly opcode: BrainfuckOpcode;
  readonly operand: number;
}

export function brainfuckOpcodeName(opcode: BrainfuckOpcode): string {
  switch (opcode) {
    case BrainfuckOpcode.NOP:
      return "NOP";
    case BrainfuckOpcode.Right:
      return "Right";
    case BrainfuckOpcode.Left:
      return "Left";
    case BrainfuckOpcode.Increment:
      return "Increment";
    case BrainfuckOpcode.Decrement:
      return "Decrement";
    case BrainfuckOpcode.Output:
      return "Output";
    case BrainfuckOpcode.Input:
      return "Input";
    case BrainfuckOpcode.LoopStart:
      return "LoopStart";
    case BrainfuckOpcode.LoopEnd:
      return "LoopEnd";
  }
}
