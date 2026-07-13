export const BRAINFUCK_COMPILER_SHADER = /* wgsl */ `
struct Instruction {
  opcode: u32,
  operand: u32,
}

struct CompilationState {
  source_length: u32,
  status: u32,
  error_offset: u32,
  instruction_count: u32,
}

@group(0) @binding(0)
var<storage, read> source_words: array<u32>;

@group(0) @binding(1)
var<storage, read_write> instructions: array<Instruction>;

@group(0) @binding(2)
var<storage, read_write> state: CompilationState;

const STATUS_PENDING: u32 = 0u;
const STATUS_OK: u32 = 1u;
const STATUS_UNMATCHED_CLOSING_BRACKET: u32 = 2u;
const STATUS_UNMATCHED_OPENING_BRACKET: u32 = 3u;
const NO_SOURCE_OFFSET: u32 = 0xffffffffu;

const OPCODE_NOP: u32 = 0u;
const OPCODE_RIGHT: u32 = 1u;
const OPCODE_LEFT: u32 = 2u;
const OPCODE_INCREMENT: u32 = 3u;
const OPCODE_DECREMENT: u32 = 4u;
const OPCODE_OUTPUT: u32 = 5u;
const OPCODE_INPUT: u32 = 6u;
const OPCODE_LOOP_START: u32 = 7u;
const OPCODE_LOOP_END: u32 = 8u;

fn write_instruction(source_offset: u32, opcode: u32, operand: u32) {
  instructions[source_offset] = Instruction(opcode, operand);
}

@compute @workgroup_size(1)
fn compile_brainfuck() {
  state.status = STATUS_PENDING;
  state.error_offset = NO_SOURCE_OFFSET;
  state.instruction_count = 0u;

  var stack_head = NO_SOURCE_OFFSET;
  var outermost_unclosed = NO_SOURCE_OFFSET;
  var source_offset = 0u;

  loop {
    if source_offset >= state.source_length {
      break;
    }

    let source_word = source_words[source_offset / 4u];
    let source_word_shift = (source_offset % 4u) * 8u;
    let source_byte = (source_word >> source_word_shift) & 0xffu;

    switch source_byte {
      case 62u: {
        write_instruction(source_offset, OPCODE_RIGHT, 0u);
      }
      case 60u: {
        write_instruction(source_offset, OPCODE_LEFT, 0u);
      }
      case 43u: {
        write_instruction(source_offset, OPCODE_INCREMENT, 0u);
      }
      case 45u: {
        write_instruction(source_offset, OPCODE_DECREMENT, 0u);
      }
      case 46u: {
        write_instruction(source_offset, OPCODE_OUTPUT, 0u);
      }
      case 44u: {
        write_instruction(source_offset, OPCODE_INPUT, 0u);
      }
      case 91u: {
        write_instruction(source_offset, OPCODE_LOOP_START, stack_head);
        if stack_head == NO_SOURCE_OFFSET {
          outermost_unclosed = source_offset;
        }
        stack_head = source_offset;
      }
      case 93u: {
        if stack_head == NO_SOURCE_OFFSET {
          state.status = STATUS_UNMATCHED_CLOSING_BRACKET;
          state.error_offset = source_offset;
          return;
        }

        let opening_offset = stack_head;
        stack_head = instructions[opening_offset].operand;
        instructions[opening_offset].operand = source_offset + 1u;
        write_instruction(source_offset, OPCODE_LOOP_END, opening_offset + 1u);

        if stack_head == NO_SOURCE_OFFSET {
          outermost_unclosed = NO_SOURCE_OFFSET;
        }
      }
      default: {
        write_instruction(source_offset, OPCODE_NOP, 0u);
      }
    }

    source_offset += 1u;
  }

  if stack_head != NO_SOURCE_OFFSET {
    state.status = STATUS_UNMATCHED_OPENING_BRACKET;
    state.error_offset = outermost_unclosed;
    return;
  }

  state.status = STATUS_OK;
  state.instruction_count = state.source_length;
}
`;
