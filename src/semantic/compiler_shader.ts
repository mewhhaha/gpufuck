import { LAZULI_MAXIMUM_CONSTRUCTOR_ARITY } from "./abi.ts";
import { LAZULI_INDEXED_LOCAL_RESOLUTION_MAGIC } from "./symbol_lookup.ts";

export const LAZULI_COMPILATION_STATE_WORD_LENGTH = 24;
export const LAZULI_COMPILATION_STATE_BYTE_LENGTH = LAZULI_COMPILATION_STATE_WORD_LENGTH *
  Uint32Array.BYTES_PER_ELEMENT;
export const LAZULI_COMPILATION_INTERNAL_STATE_WORD_LENGTH = 32;
export const LAZULI_COMPILATION_INTERNAL_STATE_BYTE_LENGTH =
  LAZULI_COMPILATION_INTERNAL_STATE_WORD_LENGTH * Uint32Array.BYTES_PER_ELEMENT;

export const LazuliCompilationStateWord = {
  NodeCount: 0,
  DefinitionCount: 1,
  TypeCount: 2,
  ConstructorCount: 3,
  EntrySymbol: 4,
  Status: 5,
  ErrorCode: 6,
  ErrorSource: 7,
  ErrorDetail: 8,
  EntryDefinition: 9,
  TotalSteps: 10,
  MaximumSteps: 11,
  MaximumStepsPerDispatch: 12,
  Phase: 13,
  PrimaryCursor: 14,
  SecondaryCursor: 15,
  TertiaryCursor: 16,
  ResolutionNode: 17,
  ResolutionParent: 18,
  ResolutionChild: 19,
  ResolutionDepth: 20,
  ResolutionSymbol: 21,
  CoreTag: 22,
  CorePayload: 23,
} as const;

export const LazuliCompilationInternalStateWord = {
  SurfaceNodeBase: 24,
  DefinitionBase: 25,
  AlgebraicTypeBase: 26,
  ConstructorBase: 27,
  CoreNodeBase: 28,
  InferenceOutputBase: 29,
  SymbolCount: 30,
  SymbolLookupBase: 31,
} as const;

export const LazuliCompilationStatus = {
  Pending: 0,
  Ok: 1,
  Diagnostic: 2,
  InvalidSurface: 3,
  StepLimit: 4,
} as const;

export const LAZULI_COMPILER_SHADER = /* wgsl */ `
struct SurfaceNode {
  tag: u32,
  start_byte: u32,
  end_byte: u32,
  payload: u32,
  child0: u32,
  child1: u32,
  child2: u32,
  parent: u32,
}

struct Definition {
  symbol: u32,
  root_node: u32,
  start_byte: u32,
  end_byte: u32,
}

struct AlgebraicType {
  symbol: u32,
  first_constructor: u32,
  constructor_count: u32,
  start_byte: u32,
  end_byte: u32,
}

struct Constructor {
  symbol: u32,
  type_index: u32,
  arity: u32,
  start_byte: u32,
  end_byte: u32,
}

struct CoreNode {
  tag: u32,
  payload: u32,
  child0: u32,
  child1: u32,
  child2: u32,
  source_byte_offset: u32,
  source_end_byte: u32,
  evaluation_mode: u32,
}

struct SymbolLookup {
  definition: u32,
  algebraic_type: u32,
  constructor: u32,
  case_node: u32,
}

struct CompilationState {
  node_count: u32,
  definition_count: u32,
  type_count: u32,
  constructor_count: u32,
  entry_symbol: u32,
  status: u32,
  error_code: u32,
  error_source: u32,
  error_detail: u32,
  entry_definition: u32,
  total_steps: u32,
  maximum_steps: u32,
  maximum_steps_per_dispatch: u32,
  phase: u32,
  primary_cursor: u32,
  secondary_cursor: u32,
  tertiary_cursor: u32,
  resolution_node: u32,
  resolution_parent: u32,
  resolution_child: u32,
  resolution_depth: u32,
  resolution_symbol: u32,
  core_tag: u32,
  core_payload: u32,
  surface_node_base: u32,
  definition_base: u32,
  algebraic_type_base: u32,
  constructor_base: u32,
  core_node_base: u32,
  inference_output_base: u32,
  symbol_count: u32,
  symbol_lookup_base: u32,
}

@group(0) @binding(0)
var<storage, read_write> surface_nodes: array<SurfaceNode>;

@group(0) @binding(1)
var<storage, read> definitions: array<Definition>;

@group(0) @binding(2)
var<storage, read> algebraic_types: array<AlgebraicType>;

@group(0) @binding(3)
var<storage, read> constructors: array<Constructor>;

@group(0) @binding(4)
var<storage, read_write> core_nodes: array<CoreNode>;

@group(0) @binding(5)
var<storage, read_write> compilation_states: array<CompilationState>;

@group(0) @binding(6)
var<storage, read_write> symbol_lookups: array<SymbolLookup>;

var<private> state: CompilationState;

const NO_INDEX: u32 = 0xffffffffu;
const MAXIMUM_CONSTRUCTOR_ARITY: u32 = ${LAZULI_MAXIMUM_CONSTRUCTOR_ARITY}u;
const INDEXED_LOCAL_RESOLUTION_MAGIC: u32 = ${LAZULI_INDEXED_LOCAL_RESOLUTION_MAGIC}u;

const STATUS_PENDING: u32 = 0u;
const STATUS_OK: u32 = 1u;
const STATUS_DIAGNOSTIC: u32 = 2u;
const STATUS_INVALID_SURFACE: u32 = 3u;
const STATUS_STEP_LIMIT: u32 = 4u;

const ERROR_NONE: u32 = 0u;
const ERROR_UNKNOWN_NAME: u32 = 1u;
const ERROR_DUPLICATE_DEFINITION: u32 = 2u;
const ERROR_MISSING_MAIN: u32 = 3u;
const ERROR_DUPLICATE_TYPE: u32 = 4u;
const ERROR_DUPLICATE_CONSTRUCTOR: u32 = 5u;
const ERROR_DEFINITION_CONSTRUCTOR_COLLISION: u32 = 6u;
const ERROR_UNKNOWN_CASE_CONSTRUCTOR: u32 = 7u;
const ERROR_PATTERN_ARITY_MISMATCH: u32 = 8u;
const ERROR_DUPLICATE_CASE_ARM: u32 = 9u;
const ERROR_INVALID_COUNTS: u32 = 100u;
const ERROR_INVALID_NODE: u32 = 101u;
const ERROR_INVALID_DEFINITION: u32 = 102u;
const ERROR_INVALID_TYPE: u32 = 103u;
const ERROR_INVALID_CONSTRUCTOR: u32 = 104u;

const SURFACE_INTEGER: u32 = 1u;
const SURFACE_BOOLEAN: u32 = 2u;
const SURFACE_NAME: u32 = 3u;
const SURFACE_LET: u32 = 4u;
const SURFACE_IF: u32 = 5u;
const SURFACE_LAMBDA: u32 = 6u;
const SURFACE_APPLY: u32 = 7u;
const SURFACE_UNARY: u32 = 8u;
const SURFACE_BINARY: u32 = 9u;
const SURFACE_CASE: u32 = 10u;
const SURFACE_CASE_ARM: u32 = 11u;
const SURFACE_PATTERN_BIND: u32 = 12u;
const SURFACE_LET_REC: u32 = 16u;
const SURFACE_STRICT_LET: u32 = 17u;
const SURFACE_STRICT_APPLY: u32 = 18u;
const SURFACE_SIGNED_INTEGER_64: u32 = 19u;
const SURFACE_FLOAT_32: u32 = 20u;
const SURFACE_FLOAT_64: u32 = 21u;
const SURFACE_NUMERIC_CONVERT: u32 = 22u;
const SURFACE_TEXT: u32 = 23u;
const SURFACE_BYTES: u32 = 24u;
const SURFACE_RUNTIME_FAULT: u32 = 25u;
const SURFACE_WHOLE_NUMBER_F64: u32 = 26u;
const SURFACE_BUFFER_APPEND: u32 = 27u;

const CORE_LOCAL: u32 = 13u;
const CORE_GLOBAL: u32 = 14u;
const CORE_CONSTRUCTOR: u32 = 15u;

const PHASE_UNINITIALIZED: u32 = 0u;
const PHASE_VALIDATE_COUNTS: u32 = 1u;
const PHASE_VALIDATE_NODE: u32 = 2u;
const PHASE_VALIDATE_DEFINITION: u32 = 3u;
const PHASE_VALIDATE_TYPE: u32 = 4u;
const PHASE_VALIDATE_TYPE_TOTAL: u32 = 5u;
const PHASE_VALIDATE_CONSTRUCTOR: u32 = 6u;
const PHASE_FIND_DUPLICATE_DEFINITION: u32 = 7u;
const PHASE_FIND_DUPLICATE_TYPE: u32 = 8u;
const PHASE_FIND_DUPLICATE_CONSTRUCTOR: u32 = 9u;
const PHASE_FIND_DEFINITION_CONSTRUCTOR_COLLISION: u32 = 10u;
const PHASE_FIND_ENTRY_DEFINITION: u32 = 11u;
const PHASE_LOWER_NODE: u32 = 12u;
const PHASE_RESOLVE_LOCAL_NAME: u32 = 13u;
const PHASE_RESOLVE_GLOBAL_NAME: u32 = 14u;
const PHASE_RESOLVE_CONSTRUCTOR_NAME: u32 = 15u;
const PHASE_RESOLVE_CASE_CONSTRUCTOR: u32 = 16u;
const PHASE_COUNT_PATTERN_BINDERS: u32 = 17u;
const PHASE_FIND_CASE_PARENT: u32 = 18u;

fn region_fits(base: u32, count: u32, length: u32) -> bool {
  return base <= length && count <= length - base;
}

fn symbol_lookup(symbol: u32) -> SymbolLookup {
  return symbol_lookups[state.symbol_lookup_base + symbol];
}

fn indexed_local_resolutions_are_available() -> bool {
  let header_index = state.symbol_lookup_base + state.symbol_count;
  if header_index >= arrayLength(&symbol_lookups) { return false; }
  let header = symbol_lookups[header_index];
  return header.definition == INDEXED_LOCAL_RESOLUTION_MAGIC &&
    header.algebraic_type == state.node_count &&
    state.node_count < arrayLength(&symbol_lookups) - header_index;
}

fn indexed_local_resolution(node: u32) -> SymbolLookup {
  return symbol_lookups[state.symbol_lookup_base + state.symbol_count + 1u + node];
}

fn report_diagnostic(code: u32, source: u32, detail: u32) {
  state.status = STATUS_DIAGNOSTIC;
  state.error_code = code;
  state.error_source = source;
  state.error_detail = detail;
}

fn report_invalid_surface(code: u32, detail: u32) {
  state.status = STATUS_INVALID_SURFACE;
  state.error_code = code;
  state.error_source = NO_INDEX;
  state.error_detail = detail;
}

fn required_child_is_valid(parent_index: u32, child_index: u32) -> bool {
  if child_index == NO_INDEX || child_index >= state.node_count || child_index <= parent_index {
    return false;
  }
  return surface_nodes[state.surface_node_base + child_index].parent == parent_index;
}

fn optional_child_is_valid(parent_index: u32, child_index: u32) -> bool {
  return child_index == NO_INDEX || required_child_is_valid(parent_index, child_index);
}

fn parent_is_valid(node_index: u32, parent_index: u32) -> bool {
  if parent_index == NO_INDEX {
    return true;
  }
  if parent_index >= node_index {
    return false;
  }

  let parent = surface_nodes[state.surface_node_base + parent_index];
  return parent.child0 == node_index || parent.child1 == node_index || parent.child2 == node_index;
}

fn case_arm_parent_is_valid(node_index: u32, parent_index: u32) -> bool {
  if parent_index == NO_INDEX || parent_index >= node_index {
    return false;
  }
  let parent = surface_nodes[state.surface_node_base + parent_index];
  return (parent.tag == SURFACE_CASE || parent.tag == SURFACE_CASE_ARM) &&
    parent.child1 == node_index;
}

fn pattern_bind_parent_is_valid(node_index: u32, parent_index: u32) -> bool {
  if parent_index == NO_INDEX || parent_index >= node_index {
    return false;
  }
  let parent = surface_nodes[state.surface_node_base + parent_index];
  return (parent.tag == SURFACE_CASE_ARM || parent.tag == SURFACE_PATTERN_BIND) &&
    parent.child0 == node_index;
}

fn node_shape_is_valid(node_index: u32, node: SurfaceNode) -> bool {
  if !parent_is_valid(node_index, node.parent) || node.start_byte > node.end_byte {
    return false;
  }

  switch node.tag {
    case SURFACE_INTEGER: {
      return node.child0 == NO_INDEX && node.child1 == NO_INDEX && node.child2 == NO_INDEX;
    }
    case SURFACE_SIGNED_INTEGER_64, SURFACE_FLOAT_64: {
      return node.child1 == NO_INDEX && node.child2 == NO_INDEX;
    }
    case SURFACE_WHOLE_NUMBER_F64: {
      return node.child1 < state.type_count && node.child2 == NO_INDEX;
    }
    case SURFACE_FLOAT_32: {
      return node.child0 == NO_INDEX && node.child1 == NO_INDEX && node.child2 == NO_INDEX;
    }
    case SURFACE_TEXT, SURFACE_BYTES: {
      return node.child0 < state.type_count && node.child1 == NO_INDEX && node.child2 == NO_INDEX;
    }
    case SURFACE_RUNTIME_FAULT: {
      return node.child0 == NO_INDEX && node.child1 == NO_INDEX && node.child2 == NO_INDEX;
    }
    case SURFACE_BOOLEAN: {
      return node.payload <= 1u && node.child0 == NO_INDEX && node.child1 == NO_INDEX &&
        node.child2 == NO_INDEX;
    }
    case SURFACE_NAME: {
      return node.payload < state.symbol_count && node.child0 == NO_INDEX &&
        node.child1 == NO_INDEX && node.child2 == NO_INDEX;
    }
    case SURFACE_LET, SURFACE_STRICT_LET: {
      return node.payload < state.symbol_count && required_child_is_valid(node_index, node.child0) &&
        required_child_is_valid(node_index, node.child1) && node.child2 == NO_INDEX;
    }
    case SURFACE_LET_REC: {
      return node.payload < state.symbol_count && required_child_is_valid(node_index, node.child0) &&
        surface_nodes[state.surface_node_base + node.child0].tag == SURFACE_LAMBDA &&
        required_child_is_valid(node_index, node.child1) && node.child2 == NO_INDEX;
    }
    case SURFACE_IF: {
      return required_child_is_valid(node_index, node.child0) &&
        required_child_is_valid(node_index, node.child1) &&
        required_child_is_valid(node_index, node.child2);
    }
    case SURFACE_LAMBDA: {
      return node.payload < state.symbol_count && required_child_is_valid(node_index, node.child0) &&
        node.child1 == NO_INDEX && node.child2 == NO_INDEX;
    }
    case SURFACE_APPLY, SURFACE_STRICT_APPLY: {
      return required_child_is_valid(node_index, node.child0) &&
        required_child_is_valid(node_index, node.child1) && node.child2 == NO_INDEX;
    }
    case SURFACE_UNARY: {
      let whole_number = node.payload == 6u;
      return node.payload >= 1u && node.payload <= 6u &&
        required_child_is_valid(node_index, node.child0) &&
        select(node.child1 == NO_INDEX, node.child1 < state.type_count, whole_number) &&
        node.child2 == NO_INDEX;
    }
    case SURFACE_NUMERIC_CONVERT: {
      return node.payload >= 1u && node.payload <= 14u &&
        required_child_is_valid(node_index, node.child0) &&
        node.child1 == NO_INDEX && node.child2 == NO_INDEX;
    }
    case SURFACE_BINARY: {
      let whole_number = node.payload >= 55u && node.payload <= 65u;
      return node.payload >= 1u && node.payload <= 65u &&
        required_child_is_valid(node_index, node.child0) &&
        required_child_is_valid(node_index, node.child1) &&
        select(node.child2 == NO_INDEX, node.child2 < state.type_count, whole_number);
    }
    case SURFACE_BUFFER_APPEND: {
      return node.payload == 0u && required_child_is_valid(node_index, node.child0) &&
        required_child_is_valid(node_index, node.child1) && node.child2 < state.type_count;
    }
    case SURFACE_CASE: {
      return required_child_is_valid(node_index, node.child0) &&
        optional_child_is_valid(node_index, node.child1) && node.child2 == NO_INDEX;
    }
    case SURFACE_CASE_ARM: {
      return node.payload < state.symbol_count && case_arm_parent_is_valid(node_index, node.parent) &&
        required_child_is_valid(node_index, node.child0) &&
        optional_child_is_valid(node_index, node.child1) && node.child2 == NO_INDEX;
    }
    case SURFACE_PATTERN_BIND: {
      return node.payload < state.symbol_count && pattern_bind_parent_is_valid(node_index, node.parent) &&
        required_child_is_valid(node_index, node.child0) && node.child1 == NO_INDEX &&
        node.child2 == NO_INDEX;
    }
    default: {
      return false;
    }
  }
}

fn initialize_compilation() {
  if state.phase != PHASE_UNINITIALIZED {
    return;
  }

  state.error_code = ERROR_NONE;
  state.error_source = NO_INDEX;
  state.error_detail = NO_INDEX;
  state.entry_definition = NO_INDEX;
  state.total_steps = 0u;
  state.primary_cursor = 0u;
  state.secondary_cursor = 0u;
  state.tertiary_cursor = 0u;
  state.resolution_node = NO_INDEX;
  state.resolution_parent = NO_INDEX;
  state.resolution_child = NO_INDEX;
  state.resolution_depth = 0u;
  state.resolution_symbol = NO_INDEX;
  state.core_tag = 0u;
  state.core_payload = 0u;

  if state.maximum_steps == 0u || state.maximum_steps_per_dispatch == 0u {
    report_invalid_surface(ERROR_INVALID_COUNTS, 0u);
    return;
  }

  state.phase = PHASE_VALIDATE_COUNTS;
}

fn validate_counts() {
  if !region_fits(state.surface_node_base, state.node_count, arrayLength(&surface_nodes)) ||
    !region_fits(state.core_node_base, state.node_count, arrayLength(&core_nodes)) ||
    !region_fits(state.definition_base, state.definition_count, arrayLength(&definitions)) ||
    !region_fits(state.algebraic_type_base, state.type_count, arrayLength(&algebraic_types)) ||
    !region_fits(state.constructor_base, state.constructor_count, arrayLength(&constructors)) ||
    !region_fits(state.symbol_lookup_base, state.symbol_count, arrayLength(&symbol_lookups)) ||
    state.entry_symbol >= state.symbol_count {
    report_invalid_surface(ERROR_INVALID_COUNTS, 0u);
    return;
  }

  state.primary_cursor = 0u;
  state.phase = PHASE_VALIDATE_NODE;
}

fn validate_node() {
  if state.primary_cursor >= state.node_count {
    state.primary_cursor = 0u;
    state.phase = PHASE_VALIDATE_DEFINITION;
    return;
  }

  if !node_shape_is_valid(
    state.primary_cursor,
    surface_nodes[state.surface_node_base + state.primary_cursor],
  ) {
    report_invalid_surface(ERROR_INVALID_NODE, state.primary_cursor);
    return;
  }
  state.primary_cursor += 1u;
}

fn validate_definition() {
  if state.primary_cursor >= state.definition_count {
    state.primary_cursor = 0u;
    state.tertiary_cursor = 0u;
    state.phase = PHASE_VALIDATE_TYPE;
    return;
  }

  let definition = definitions[state.definition_base + state.primary_cursor];
  if definition.symbol >= state.symbol_count || definition.root_node >= state.node_count {
    report_invalid_surface(ERROR_INVALID_DEFINITION, state.primary_cursor);
    return;
  }
  if definition.start_byte > definition.end_byte ||
    (state.primary_cursor > 0u &&
      definition.start_byte <
        definitions[state.definition_base + state.primary_cursor - 1u].start_byte) ||
    surface_nodes[state.surface_node_base + definition.root_node].parent != NO_INDEX {
    report_invalid_surface(ERROR_INVALID_DEFINITION, state.primary_cursor);
    return;
  }
  state.primary_cursor += 1u;
}

fn validate_type() {
  if state.primary_cursor >= state.type_count {
    state.phase = PHASE_VALIDATE_TYPE_TOTAL;
    return;
  }

  let algebraic_type = algebraic_types[state.algebraic_type_base + state.primary_cursor];
  if algebraic_type.symbol >= state.symbol_count ||
    algebraic_type.start_byte > algebraic_type.end_byte ||
    (state.primary_cursor > 0u &&
      algebraic_type.start_byte <
        algebraic_types[state.algebraic_type_base + state.primary_cursor - 1u].start_byte) ||
    algebraic_type.first_constructor != state.tertiary_cursor ||
    algebraic_type.first_constructor > state.constructor_count ||
    algebraic_type.constructor_count > state.constructor_count - algebraic_type.first_constructor {
    report_invalid_surface(ERROR_INVALID_TYPE, state.primary_cursor);
    return;
  }
  state.tertiary_cursor = algebraic_type.first_constructor + algebraic_type.constructor_count;
  state.primary_cursor += 1u;
}

fn validate_type_total() {
  if state.tertiary_cursor != state.constructor_count {
    report_invalid_surface(ERROR_INVALID_TYPE, state.type_count);
    return;
  }
  state.primary_cursor = 0u;
  state.phase = PHASE_VALIDATE_CONSTRUCTOR;
}

fn validate_constructor() {
  if state.primary_cursor >= state.constructor_count {
    state.primary_cursor = 0u;
    state.secondary_cursor = 0u;
    state.phase = PHASE_FIND_DUPLICATE_DEFINITION;
    return;
  }

  let constructor = constructors[state.constructor_base + state.primary_cursor];
  if constructor.symbol >= state.symbol_count || constructor.type_index >= state.type_count {
    report_invalid_surface(ERROR_INVALID_CONSTRUCTOR, state.primary_cursor);
    return;
  }
  let algebraic_type = algebraic_types[state.algebraic_type_base + constructor.type_index];
  if constructor.start_byte > constructor.end_byte ||
    (state.primary_cursor > 0u &&
      constructor.start_byte <
        constructors[state.constructor_base + state.primary_cursor - 1u].start_byte) ||
    constructor.arity > MAXIMUM_CONSTRUCTOR_ARITY ||
    state.primary_cursor < algebraic_type.first_constructor ||
    state.primary_cursor - algebraic_type.first_constructor >= algebraic_type.constructor_count {
    report_invalid_surface(ERROR_INVALID_CONSTRUCTOR, state.primary_cursor);
    return;
  }
  state.primary_cursor += 1u;
}

fn find_duplicate_definition() {
  if state.primary_cursor >= state.definition_count {
    state.primary_cursor = 0u;
    state.secondary_cursor = 0u;
    state.phase = PHASE_FIND_DUPLICATE_TYPE;
    return;
  }
  let definition = definitions[state.definition_base + state.primary_cursor];
  if symbol_lookup(definition.symbol).definition != state.primary_cursor {
    report_diagnostic(ERROR_DUPLICATE_DEFINITION, definition.start_byte, definition.symbol);
    return;
  }
  state.primary_cursor += 1u;
}

fn find_duplicate_type() {
  if state.primary_cursor >= state.type_count {
    state.primary_cursor = 0u;
    state.secondary_cursor = 0u;
    state.phase = PHASE_FIND_DUPLICATE_CONSTRUCTOR;
    return;
  }
  let algebraic_type = algebraic_types[state.algebraic_type_base + state.primary_cursor];
  if symbol_lookup(algebraic_type.symbol).algebraic_type != state.primary_cursor {
    report_diagnostic(ERROR_DUPLICATE_TYPE, algebraic_type.start_byte, algebraic_type.symbol);
    return;
  }
  state.primary_cursor += 1u;
}

fn find_duplicate_constructor() {
  if state.primary_cursor >= state.constructor_count {
    state.primary_cursor = 0u;
    state.phase = PHASE_FIND_ENTRY_DEFINITION;
    return;
  }
  let constructor = constructors[state.constructor_base + state.primary_cursor];
  let lookup = symbol_lookup(constructor.symbol);
  if lookup.constructor != state.primary_cursor {
    report_diagnostic(ERROR_DUPLICATE_CONSTRUCTOR, constructor.start_byte, constructor.symbol);
    return;
  }
  if lookup.definition != NO_INDEX {
    let definition = definitions[state.definition_base + lookup.definition];
    var conflict_start = constructor.start_byte;
    if definition.start_byte > conflict_start {
      conflict_start = definition.start_byte;
    }
    report_diagnostic(
      ERROR_DEFINITION_CONSTRUCTOR_COLLISION,
      conflict_start,
      constructor.symbol,
    );
    return;
  }
  state.primary_cursor += 1u;
}

fn find_entry_definition() {
  let definition = symbol_lookup(state.entry_symbol).definition;
  if definition == NO_INDEX {
    report_diagnostic(ERROR_MISSING_MAIN, NO_INDEX, state.entry_symbol);
    return;
  }
  state.entry_definition = definition;
  state.primary_cursor = 0u;
  state.phase = PHASE_LOWER_NODE;
}

fn write_lowered_node() {
  let surface_node = surface_nodes[state.surface_node_base + state.primary_cursor];
  core_nodes[state.core_node_base + state.primary_cursor] = CoreNode(
    state.core_tag,
    state.core_payload,
    surface_node.child0,
    surface_node.child1,
    surface_node.child2,
    surface_node.start_byte,
    surface_node.end_byte,
    select(
      0u,
      1u,
      surface_node.tag == SURFACE_STRICT_LET || surface_node.tag == SURFACE_STRICT_APPLY,
    ),
  );
  state.primary_cursor += 1u;
  if state.primary_cursor == state.node_count {
    state.status = STATUS_OK;
    return;
  }
  state.phase = PHASE_LOWER_NODE;
}

fn lower_node() {
  if state.primary_cursor >= state.node_count {
    state.status = STATUS_OK;
    return;
  }

  let surface_node = surface_nodes[state.surface_node_base + state.primary_cursor];
  state.core_tag = surface_node.tag;
  state.core_payload = surface_node.payload;
  if surface_node.tag == SURFACE_STRICT_LET {
    state.core_tag = SURFACE_LET;
  } else if surface_node.tag == SURFACE_STRICT_APPLY {
    state.core_tag = SURFACE_APPLY;
  }
  if surface_node.tag == SURFACE_LET || surface_node.tag == SURFACE_STRICT_LET {
    state.core_payload = 1u;
    if indexed_local_resolutions_are_available() {
      state.core_payload = select(
        0u,
        1u,
        indexed_local_resolution(state.primary_cursor).case_node != 0u,
      );
    }
  }
  if surface_node.tag == SURFACE_NAME {
    state.resolution_node = state.primary_cursor;
    state.resolution_symbol = surface_node.payload;
    if indexed_local_resolutions_are_available() {
      let resolution = indexed_local_resolution(state.primary_cursor);
      if resolution.definition == CORE_LOCAL {
        state.core_tag = CORE_LOCAL;
        state.core_payload = resolution.algebraic_type;
        write_lowered_node();
        return;
      }
      state.phase = PHASE_RESOLVE_GLOBAL_NAME;
      return;
    }
    state.resolution_parent = surface_node.parent;
    state.resolution_child = state.primary_cursor;
    state.resolution_depth = 0u;
    state.phase = PHASE_RESOLVE_LOCAL_NAME;
    return;
  }
  if surface_node.tag == SURFACE_CASE_ARM {
    state.resolution_node = state.primary_cursor;
    state.resolution_symbol = surface_node.payload;
    state.secondary_cursor = 0u;
    state.phase = PHASE_RESOLVE_CASE_CONSTRUCTOR;
    return;
  }
  write_lowered_node();
}

fn resolve_local_name() {
  if state.resolution_parent == NO_INDEX {
    state.secondary_cursor = 0u;
    state.phase = PHASE_RESOLVE_GLOBAL_NAME;
    return;
  }

  let parent = surface_nodes[state.surface_node_base + state.resolution_parent];
  let introduces_let_binding = (parent.tag == SURFACE_LET ||
    parent.tag == SURFACE_STRICT_LET) &&
    parent.child1 == state.resolution_child;
  let introduces_let_rec_binding = parent.tag == SURFACE_LET_REC &&
    (parent.child0 == state.resolution_child || parent.child1 == state.resolution_child);
  let introduces_lambda_binding = parent.tag == SURFACE_LAMBDA &&
    parent.child0 == state.resolution_child;
  let introduces_pattern_binding = parent.tag == SURFACE_PATTERN_BIND &&
    parent.child0 == state.resolution_child;
  if introduces_let_binding || introduces_let_rec_binding || introduces_lambda_binding ||
    introduces_pattern_binding {
    if parent.payload == state.resolution_symbol {
      state.core_tag = CORE_LOCAL;
      state.core_payload = state.resolution_depth;
      write_lowered_node();
      return;
    }
    state.resolution_depth += 1u;
  }
  state.resolution_child = state.resolution_parent;
  state.resolution_parent = parent.parent;
}

fn resolve_global_name() {
  let definition = symbol_lookup(state.resolution_symbol).definition;
  if definition == NO_INDEX {
    state.phase = PHASE_RESOLVE_CONSTRUCTOR_NAME;
    return;
  }
  state.core_tag = CORE_GLOBAL;
  state.core_payload = definition;
  write_lowered_node();
}

fn resolve_constructor_name() {
  let constructor = symbol_lookup(state.resolution_symbol).constructor;
  if constructor == NO_INDEX {
    let surface_node = surface_nodes[state.surface_node_base + state.resolution_node];
    report_diagnostic(ERROR_UNKNOWN_NAME, surface_node.start_byte, state.resolution_symbol);
    return;
  }
  state.core_tag = CORE_CONSTRUCTOR;
  state.core_payload = constructor;
  write_lowered_node();
}

fn resolve_case_constructor() {
  let constructor = symbol_lookup(state.resolution_symbol).constructor;
  if constructor == NO_INDEX {
    let surface_node = surface_nodes[state.surface_node_base + state.resolution_node];
    report_diagnostic(ERROR_UNKNOWN_CASE_CONSTRUCTOR, surface_node.start_byte, state.resolution_symbol);
    return;
  }
  state.core_payload = constructor;
  state.resolution_child =
    surface_nodes[state.surface_node_base + state.resolution_node].child0;
  state.resolution_depth = 0u;
  state.phase = PHASE_COUNT_PATTERN_BINDERS;
}

fn count_pattern_binders() {
  if state.resolution_child < state.node_count &&
    surface_nodes[state.surface_node_base + state.resolution_child].tag ==
      SURFACE_PATTERN_BIND {
    state.resolution_depth += 1u;
    state.resolution_child =
      surface_nodes[state.surface_node_base + state.resolution_child].child0;
    return;
  }
  if state.resolution_depth != constructors[state.constructor_base + state.core_payload].arity {
    let surface_node = surface_nodes[state.surface_node_base + state.resolution_node];
    report_diagnostic(ERROR_PATTERN_ARITY_MISMATCH, surface_node.start_byte, state.resolution_node);
    return;
  }
  state.resolution_parent = surface_nodes[state.surface_node_base + state.resolution_node].parent;
  state.phase = PHASE_FIND_CASE_PARENT;
}

fn find_case_parent() {
  if state.resolution_parent >= state.node_count {
    write_lowered_node();
    return;
  }
  let parent = surface_nodes[state.surface_node_base + state.resolution_parent];
  if parent.tag == SURFACE_CASE {
    surface_nodes[state.surface_node_base + state.resolution_node].parent =
      state.resolution_parent;
    let lookup_address = state.symbol_lookup_base + state.resolution_symbol;
    if symbol_lookups[lookup_address].case_node == state.resolution_parent {
      let surface_node = surface_nodes[state.surface_node_base + state.resolution_node];
      report_diagnostic(
        ERROR_DUPLICATE_CASE_ARM,
        surface_node.start_byte,
        state.resolution_symbol,
      );
      return;
    }
    symbol_lookups[lookup_address].case_node = state.resolution_parent;
    write_lowered_node();
    return;
  }
  state.resolution_parent = parent.parent;
}

fn advance_compilation() {
  switch state.phase {
    case PHASE_VALIDATE_COUNTS: {
      validate_counts();
    }
    case PHASE_VALIDATE_NODE: {
      validate_node();
    }
    case PHASE_VALIDATE_DEFINITION: {
      validate_definition();
    }
    case PHASE_VALIDATE_TYPE: {
      validate_type();
    }
    case PHASE_VALIDATE_TYPE_TOTAL: {
      validate_type_total();
    }
    case PHASE_VALIDATE_CONSTRUCTOR: {
      validate_constructor();
    }
    case PHASE_FIND_DUPLICATE_DEFINITION: {
      find_duplicate_definition();
    }
    case PHASE_FIND_DUPLICATE_TYPE: {
      find_duplicate_type();
    }
    case PHASE_FIND_DUPLICATE_CONSTRUCTOR: {
      find_duplicate_constructor();
    }
    case PHASE_FIND_ENTRY_DEFINITION: {
      find_entry_definition();
    }
    case PHASE_LOWER_NODE: {
      lower_node();
    }
    case PHASE_RESOLVE_LOCAL_NAME: {
      resolve_local_name();
    }
    case PHASE_RESOLVE_GLOBAL_NAME: {
      resolve_global_name();
    }
    case PHASE_RESOLVE_CONSTRUCTOR_NAME: {
      resolve_constructor_name();
    }
    case PHASE_RESOLVE_CASE_CONSTRUCTOR: {
      resolve_case_constructor();
    }
    case PHASE_COUNT_PATTERN_BINDERS: {
      count_pattern_binders();
    }
    case PHASE_FIND_CASE_PARENT: {
      find_case_parent();
    }
    default: {
      report_invalid_surface(ERROR_INVALID_COUNTS, state.phase);
    }
  }
}

fn compile_lane() {
  if state.status != STATUS_PENDING {
    return;
  }
  initialize_compilation();
  if state.status != STATUS_PENDING {
    return;
  }

  let dispatch_start_steps = state.total_steps;
  loop {
    if state.status != STATUS_PENDING {
      return;
    }
    if state.total_steps >= state.maximum_steps {
      state.status = STATUS_STEP_LIMIT;
      return;
    }
    if state.total_steps - dispatch_start_steps >= state.maximum_steps_per_dispatch {
      return;
    }
    state.total_steps += 1u;
    advance_compilation();
  }
}

@compute @workgroup_size(1)
fn compile_lazuli(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let lane_index = invocation.x;
  if lane_index >= arrayLength(&compilation_states) {
    return;
  }
  state = compilation_states[lane_index];
  compile_lane();
  if state.status != STATUS_PENDING {
    state.phase = state.core_node_base;
    state.primary_cursor = state.definition_base;
    state.secondary_cursor = state.algebraic_type_base;
    state.tertiary_cursor = state.constructor_base;
    state.resolution_node = state.inference_output_base;
  }
  compilation_states[lane_index] = state;
}
`;
