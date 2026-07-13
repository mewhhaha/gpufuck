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
  reserved0: u32,
  reserved1: u32,
}

struct CompilationState {
  node_base: u32,
  node_count: u32,
  definition_base: u32,
  definition_count: u32,
  type_base: u32,
  type_count: u32,
  constructor_base: u32,
  constructor_count: u32,
  entry_symbol: u32,
  status: u32,
  error_code: u32,
  error_source: u32,
  error_detail: u32,
  entry_definition: u32,
}

@group(0) @binding(0)
var<storage, read> surface_nodes: array<SurfaceNode>;

@group(0) @binding(1)
var<storage, read> definitions: array<Definition>;

@group(0) @binding(2)
var<storage, read> algebraic_types: array<AlgebraicType>;

@group(0) @binding(3)
var<storage, read> constructors: array<Constructor>;

@group(0) @binding(4)
var<storage, read_write> core_nodes: array<CoreNode>;

@group(0) @binding(5)
var<storage, read_write> states: array<CompilationState>;

const NO_INDEX: u32 = 0xffffffffu;
const MAXIMUM_CONSTRUCTOR_ARITY: u32 = 64u;

const STATUS_PENDING: u32 = 0u;
const STATUS_OK: u32 = 1u;
const STATUS_DIAGNOSTIC: u32 = 2u;
const STATUS_INVALID_SURFACE: u32 = 3u;

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

const CORE_LOCAL: u32 = 13u;
const CORE_GLOBAL: u32 = 14u;
const CORE_CONSTRUCTOR: u32 = 15u;

fn report_diagnostic(lane: u32, code: u32, source: u32, detail: u32) {
  states[lane].status = STATUS_DIAGNOSTIC;
  states[lane].error_code = code;
  states[lane].error_source = source;
  states[lane].error_detail = detail;
}

fn report_invalid_surface(lane: u32, code: u32, detail: u32) {
  states[lane].status = STATUS_INVALID_SURFACE;
  states[lane].error_code = code;
  states[lane].error_source = NO_INDEX;
  states[lane].error_detail = detail;
}

fn required_child_is_valid(lane: u32, parent_index: u32, child_index: u32) -> bool {
  if child_index == NO_INDEX || child_index >= states[lane].node_count ||
    child_index <= parent_index {
    return false;
  }
  return surface_nodes[states[lane].node_base + child_index].parent == parent_index;
}

fn optional_child_is_valid(lane: u32, parent_index: u32, child_index: u32) -> bool {
  return child_index == NO_INDEX || required_child_is_valid(lane, parent_index, child_index);
}

fn parent_is_valid(lane: u32, node_index: u32, parent_index: u32) -> bool {
  if parent_index == NO_INDEX {
    return true;
  }
  if parent_index >= node_index {
    return false;
  }

  let parent = surface_nodes[states[lane].node_base + parent_index];
  return parent.child0 == node_index || parent.child1 == node_index || parent.child2 == node_index;
}

fn case_arm_parent_is_valid(lane: u32, node_index: u32, parent_index: u32) -> bool {
  if parent_index == NO_INDEX || parent_index >= node_index {
    return false;
  }
  let parent = surface_nodes[states[lane].node_base + parent_index];
  return (parent.tag == SURFACE_CASE || parent.tag == SURFACE_CASE_ARM) &&
    parent.child1 == node_index;
}

fn pattern_bind_parent_is_valid(lane: u32, node_index: u32, parent_index: u32) -> bool {
  if parent_index == NO_INDEX || parent_index >= node_index {
    return false;
  }
  let parent = surface_nodes[states[lane].node_base + parent_index];
  return (parent.tag == SURFACE_CASE_ARM || parent.tag == SURFACE_PATTERN_BIND) &&
    parent.child0 == node_index;
}

fn node_shape_is_valid(lane: u32, node_index: u32, node: SurfaceNode) -> bool {
  if !parent_is_valid(lane, node_index, node.parent) || node.start_byte > node.end_byte {
    return false;
  }

  switch node.tag {
    case SURFACE_INTEGER: {
      return node.child0 == NO_INDEX && node.child1 == NO_INDEX && node.child2 == NO_INDEX;
    }
    case SURFACE_BOOLEAN: {
      return node.payload <= 1u && node.child0 == NO_INDEX && node.child1 == NO_INDEX &&
        node.child2 == NO_INDEX;
    }
    case SURFACE_NAME: {
      return node.child0 == NO_INDEX && node.child1 == NO_INDEX && node.child2 == NO_INDEX;
    }
    case SURFACE_LET: {
      return required_child_is_valid(lane, node_index, node.child0) &&
        required_child_is_valid(lane, node_index, node.child1) && node.child2 == NO_INDEX;
    }
    case SURFACE_LET_REC: {
      return required_child_is_valid(lane, node_index, node.child0) &&
        surface_nodes[states[lane].node_base + node.child0].tag == SURFACE_LAMBDA &&
        required_child_is_valid(lane, node_index, node.child1) && node.child2 == NO_INDEX;
    }
    case SURFACE_IF: {
      return required_child_is_valid(lane, node_index, node.child0) &&
        required_child_is_valid(lane, node_index, node.child1) &&
        required_child_is_valid(lane, node_index, node.child2);
    }
    case SURFACE_LAMBDA: {
      return required_child_is_valid(lane, node_index, node.child0) && node.child1 == NO_INDEX &&
        node.child2 == NO_INDEX;
    }
    case SURFACE_APPLY: {
      return required_child_is_valid(lane, node_index, node.child0) &&
        required_child_is_valid(lane, node_index, node.child1) && node.child2 == NO_INDEX;
    }
    case SURFACE_UNARY: {
      return node.payload == 1u && required_child_is_valid(lane, node_index, node.child0) &&
        node.child1 == NO_INDEX && node.child2 == NO_INDEX;
    }
    case SURFACE_BINARY: {
      return node.payload >= 1u && node.payload <= 10u &&
        required_child_is_valid(lane, node_index, node.child0) &&
        required_child_is_valid(lane, node_index, node.child1) && node.child2 == NO_INDEX;
    }
    case SURFACE_CASE: {
      return required_child_is_valid(lane, node_index, node.child0) &&
        required_child_is_valid(lane, node_index, node.child1) && node.child2 == NO_INDEX;
    }
    case SURFACE_CASE_ARM: {
      return case_arm_parent_is_valid(lane, node_index, node.parent) &&
        required_child_is_valid(lane, node_index, node.child0) &&
        optional_child_is_valid(lane, node_index, node.child1) && node.child2 == NO_INDEX;
    }
    case SURFACE_PATTERN_BIND: {
      return pattern_bind_parent_is_valid(lane, node_index, node.parent) &&
        required_child_is_valid(lane, node_index, node.child0) && node.child1 == NO_INDEX &&
        node.child2 == NO_INDEX;
    }
    default: {
      return false;
    }
  }
}

fn surface_is_valid(lane: u32) -> bool {
  let lane_state = states[lane];
  if lane_state.node_base + lane_state.node_count > arrayLength(&surface_nodes) ||
    lane_state.node_base + lane_state.node_count > arrayLength(&core_nodes) ||
    lane_state.definition_base + lane_state.definition_count > arrayLength(&definitions) ||
    lane_state.type_base + lane_state.type_count > arrayLength(&algebraic_types) ||
    lane_state.constructor_base + lane_state.constructor_count > arrayLength(&constructors) {
    report_invalid_surface(lane, ERROR_INVALID_COUNTS, 0u);
    return false;
  }

  var node_index = 0u;
  loop {
    if node_index >= lane_state.node_count {
      break;
    }
    if !node_shape_is_valid(lane, node_index, surface_nodes[lane_state.node_base + node_index]) {
      report_invalid_surface(lane, ERROR_INVALID_NODE, node_index);
      return false;
    }
    node_index += 1u;
  }

  var definition_index = 0u;
  var previous_definition_start = 0u;
  loop {
    if definition_index >= lane_state.definition_count {
      break;
    }
    let definition = definitions[lane_state.definition_base + definition_index];
    if definition.root_node >= lane_state.node_count {
      report_invalid_surface(lane, ERROR_INVALID_DEFINITION, definition_index);
      return false;
    }
    if definition.start_byte > definition.end_byte ||
      (definition_index > 0u && definition.start_byte < previous_definition_start) {
      report_invalid_surface(lane, ERROR_INVALID_DEFINITION, definition_index);
      return false;
    }
    if surface_nodes[lane_state.node_base + definition.root_node].parent != NO_INDEX {
      report_invalid_surface(lane, ERROR_INVALID_DEFINITION, definition_index);
      return false;
    }
    previous_definition_start = definition.start_byte;
    definition_index += 1u;
  }

  var type_index = 0u;
  var previous_type_start = 0u;
  var expected_first_constructor = 0u;
  loop {
    if type_index >= lane_state.type_count {
      break;
    }
    let algebraic_type = algebraic_types[lane_state.type_base + type_index];
    if algebraic_type.start_byte > algebraic_type.end_byte ||
      (type_index > 0u && algebraic_type.start_byte < previous_type_start) ||
      algebraic_type.first_constructor != expected_first_constructor ||
      algebraic_type.first_constructor > lane_state.constructor_count ||
      algebraic_type.constructor_count >
        lane_state.constructor_count - algebraic_type.first_constructor {
      report_invalid_surface(lane, ERROR_INVALID_TYPE, type_index);
      return false;
    }
    previous_type_start = algebraic_type.start_byte;
    expected_first_constructor =
      algebraic_type.first_constructor + algebraic_type.constructor_count;
    type_index += 1u;
  }
  if expected_first_constructor != lane_state.constructor_count {
    report_invalid_surface(lane, ERROR_INVALID_TYPE, lane_state.type_count);
    return false;
  }

  var constructor_index = 0u;
  var previous_constructor_start = 0u;
  loop {
    if constructor_index >= lane_state.constructor_count {
      break;
    }
    let constructor = constructors[lane_state.constructor_base + constructor_index];
    if constructor.type_index >= lane_state.type_count {
      report_invalid_surface(lane, ERROR_INVALID_CONSTRUCTOR, constructor_index);
      return false;
    }
    let algebraic_type = algebraic_types[lane_state.type_base + constructor.type_index];
    if constructor.start_byte > constructor.end_byte ||
      (constructor_index > 0u && constructor.start_byte < previous_constructor_start) ||
      constructor.arity > MAXIMUM_CONSTRUCTOR_ARITY ||
      constructor_index < algebraic_type.first_constructor ||
      constructor_index - algebraic_type.first_constructor >= algebraic_type.constructor_count {
      report_invalid_surface(lane, ERROR_INVALID_CONSTRUCTOR, constructor_index);
      return false;
    }
    previous_constructor_start = constructor.start_byte;
    constructor_index += 1u;
  }

  return true;
}

fn find_global_definition(lane: u32, symbol: u32) -> u32 {
  var definition_index = 0u;
  loop {
    if definition_index >= states[lane].definition_count {
      break;
    }
    if definitions[states[lane].definition_base + definition_index].symbol == symbol {
      return definition_index;
    }
    definition_index += 1u;
  }
  return NO_INDEX;
}

fn find_constructor(lane: u32, symbol: u32) -> u32 {
  var constructor_index = 0u;
  loop {
    if constructor_index >= states[lane].constructor_count {
      break;
    }
    if constructors[states[lane].constructor_base + constructor_index].symbol == symbol {
      return constructor_index;
    }
    constructor_index += 1u;
  }
  return NO_INDEX;
}

fn resolve_name(lane: u32, node_index: u32, symbol: u32) -> u32 {
  let node_base = states[lane].node_base;
  var child_index = node_index;
  var parent_index = surface_nodes[node_base + node_index].parent;
  var local_depth = 0u;

  loop {
    if parent_index == NO_INDEX {
      break;
    }

    let parent = surface_nodes[node_base + parent_index];
    let introduces_let_binding = parent.tag == SURFACE_LET && parent.child1 == child_index;
    let introduces_let_rec_binding = parent.tag == SURFACE_LET_REC &&
      (parent.child0 == child_index || parent.child1 == child_index);
    let introduces_lambda_binding = parent.tag == SURFACE_LAMBDA && parent.child0 == child_index;
    let introduces_pattern_binding =
      parent.tag == SURFACE_PATTERN_BIND && parent.child0 == child_index;
    if introduces_let_binding || introduces_let_rec_binding || introduces_lambda_binding ||
      introduces_pattern_binding {
      if parent.payload == symbol {
        return local_depth;
      }
      local_depth += 1u;
    }

    child_index = parent_index;
    parent_index = parent.parent;
  }

  return NO_INDEX;
}

fn pattern_binder_count(lane: u32, arm_index: u32) -> u32 {
  let node_base = states[lane].node_base;
  var count = 0u;
  var node_index = surface_nodes[node_base + arm_index].child0;
  loop {
    if node_index >= states[lane].node_count ||
      surface_nodes[node_base + node_index].tag != SURFACE_PATTERN_BIND {
      break;
    }
    count += 1u;
    node_index = surface_nodes[node_base + node_index].child0;
  }
  return count;
}

fn case_has_earlier_arm(lane: u32, arm_index: u32, constructor_symbol: u32) -> bool {
  let node_base = states[lane].node_base;
  let node_count = states[lane].node_count;
  var first_arm = arm_index;
  var parent_index = surface_nodes[node_base + arm_index].parent;
  loop {
    if parent_index >= node_count {
      return false;
    }
    let parent = surface_nodes[node_base + parent_index];
    if parent.tag == SURFACE_CASE {
      first_arm = parent.child1;
      break;
    }
    parent_index = parent.parent;
  }

  var earlier_arm = first_arm;
  loop {
    if earlier_arm == arm_index {
      return false;
    }
    if earlier_arm >= node_count {
      return false;
    }
    let arm = surface_nodes[node_base + earlier_arm];
    if arm.payload == constructor_symbol {
      return true;
    }
    earlier_arm = arm.child1;
  }
  return false;
}

fn compile_lane(lane: u32) {
  states[lane].status = STATUS_PENDING;
  states[lane].error_code = ERROR_NONE;
  states[lane].error_source = NO_INDEX;
  states[lane].error_detail = NO_INDEX;
  states[lane].entry_definition = NO_INDEX;

  if !surface_is_valid(lane) {
    return;
  }

  let node_base = states[lane].node_base;
  let definition_base = states[lane].definition_base;
  let type_base = states[lane].type_base;
  let constructor_base = states[lane].constructor_base;
  let node_count = states[lane].node_count;
  let definition_count = states[lane].definition_count;
  let type_count = states[lane].type_count;
  let constructor_count = states[lane].constructor_count;

  var definition_index = 0u;
  loop {
    if definition_index >= definition_count {
      break;
    }
    let symbol = definitions[definition_base + definition_index].symbol;
    var earlier_definition_index = 0u;
    loop {
      if earlier_definition_index >= definition_index {
        break;
      }
      if definitions[definition_base + earlier_definition_index].symbol == symbol {
        report_diagnostic(
          lane,
          ERROR_DUPLICATE_DEFINITION,
          definitions[definition_base + definition_index].start_byte,
          symbol,
        );
        return;
      }
      earlier_definition_index += 1u;
    }
    definition_index += 1u;
  }

  var type_index = 0u;
  loop {
    if type_index >= type_count {
      break;
    }
    let symbol = algebraic_types[type_base + type_index].symbol;
    var earlier_type_index = 0u;
    loop {
      if earlier_type_index >= type_index {
        break;
      }
      if algebraic_types[type_base + earlier_type_index].symbol == symbol {
        report_diagnostic(
          lane,
          ERROR_DUPLICATE_TYPE,
          algebraic_types[type_base + type_index].start_byte,
          symbol,
        );
        return;
      }
      earlier_type_index += 1u;
    }
    type_index += 1u;
  }

  var constructor_index = 0u;
  loop {
    if constructor_index >= constructor_count {
      break;
    }
    let constructor = constructors[constructor_base + constructor_index];
    var earlier_constructor_index = 0u;
    loop {
      if earlier_constructor_index >= constructor_index {
        break;
      }
      if constructors[constructor_base + earlier_constructor_index].symbol == constructor.symbol {
        report_diagnostic(
          lane,
          ERROR_DUPLICATE_CONSTRUCTOR,
          constructor.start_byte,
          constructor.symbol,
        );
        return;
      }
      earlier_constructor_index += 1u;
    }

    definition_index = 0u;
    loop {
      if definition_index >= definition_count {
        break;
      }
      let definition = definitions[definition_base + definition_index];
      if definition.symbol == constructor.symbol {
        var conflict_start = constructor.start_byte;
        if definition.start_byte > conflict_start {
          conflict_start = definition.start_byte;
        }
        report_diagnostic(
          lane,
          ERROR_DEFINITION_CONSTRUCTOR_COLLISION,
          conflict_start,
          constructor.symbol,
        );
        return;
      }
      definition_index += 1u;
    }
    constructor_index += 1u;
  }

  let entry_definition = find_global_definition(lane, states[lane].entry_symbol);
  if entry_definition == NO_INDEX {
    report_diagnostic(lane, ERROR_MISSING_MAIN, NO_INDEX, states[lane].entry_symbol);
    return;
  }
  states[lane].entry_definition = entry_definition;

  var node_index = 0u;
  loop {
    if node_index >= node_count {
      break;
    }

    let surface_node = surface_nodes[node_base + node_index];
    var core_tag = surface_node.tag;
    var core_payload = surface_node.payload;
    if surface_node.tag == SURFACE_NAME {
      let local_depth = resolve_name(lane, node_index, surface_node.payload);
      if local_depth != NO_INDEX {
        core_tag = CORE_LOCAL;
        core_payload = local_depth;
      } else {
        let global_definition = find_global_definition(lane, surface_node.payload);
        if global_definition != NO_INDEX {
          core_tag = CORE_GLOBAL;
          core_payload = global_definition;
        } else {
          let named_constructor = find_constructor(lane, surface_node.payload);
          if named_constructor == NO_INDEX {
            report_diagnostic(
              lane,
              ERROR_UNKNOWN_NAME,
              surface_node.start_byte,
              surface_node.payload,
            );
            return;
          }
          core_tag = CORE_CONSTRUCTOR;
          core_payload = named_constructor;
        }
      }
    } else if surface_node.tag == SURFACE_CASE_ARM {
      let arm_constructor = find_constructor(lane, surface_node.payload);
      if arm_constructor == NO_INDEX {
        report_diagnostic(
          lane,
          ERROR_UNKNOWN_CASE_CONSTRUCTOR,
          surface_node.start_byte,
          surface_node.payload,
        );
        return;
      }
      if pattern_binder_count(lane, node_index) != constructors[constructor_base + arm_constructor].arity {
        report_diagnostic(lane, ERROR_PATTERN_ARITY_MISMATCH, surface_node.start_byte, node_index);
        return;
      }
      if case_has_earlier_arm(lane, node_index, surface_node.payload) {
        report_diagnostic(
          lane,
          ERROR_DUPLICATE_CASE_ARM,
          surface_node.start_byte,
          surface_node.payload,
        );
        return;
      }
      core_payload = arm_constructor;
    }

    core_nodes[node_base + node_index] = CoreNode(
      core_tag,
      core_payload,
      surface_node.child0,
      surface_node.child1,
      surface_node.child2,
      surface_node.start_byte,
      0u,
      0u,
    );
    node_index += 1u;
  }

  states[lane].status = STATUS_OK;
}

@compute @workgroup_size(1)
fn compile_lazuli(@builtin(global_invocation_id) global_id: vec3<u32>) {
  compile_lane(global_id.x);
}
`;
