export const FUNCTIONAL_EFFECT_CORE_NODE_WORD_LENGTH = 8;
export const FunctionalEffectCoreNodeWord = {
  Tag: 0,
  Payload: 1,
  Child0: 2,
  Child1: 3,
  Type: 4,
  Effects: 5,
  StartByte: 6,
  EndByte: 7,
} as const;

export const FunctionalEffectCoreTag = {
  Return: 1,
  HostCall: 2,
  Perform: 3,
  Bind: 4,
  Branch: 5,
  Handle: 6,
} as const;

export const FUNCTIONAL_EFFECT_CORE_OPERATION_WORD_LENGTH = 4;
export const FunctionalEffectCoreOperationWord = {
  ParameterType: 0,
  ResultType: 1,
  EffectBit: 2,
  Kind: 3,
} as const;

export const FunctionalEffectCoreScalarType = {
  Integer: 1,
  Boolean: 2,
  Unit: 3,
} as const;

export const FunctionalEffectCoreOperationKind = {
  Local: 1,
  Host: 2,
} as const;

export const FUNCTIONAL_EFFECT_CORE_NO_INDEX = 0xffff_ffff;
export const FUNCTIONAL_EFFECT_CORE_PURE = 0xffff_ffff;

export const FUNCTIONAL_EFFECT_CORE_STATE_WORD_LENGTH = 14;
export const FunctionalEffectCoreStateWord = {
  NodeCount: 0,
  OperationCount: 1,
  RootNode: 2,
  Cursor: 3,
  Phase: 4,
  Status: 5,
  Diagnostic: 6,
  DiagnosticNode: 7,
  Transitions: 8,
  MaximumTransitions: 9,
  MaximumTransitionsPerDispatch: 10,
  RootType: 11,
  RootEffects: 12,
  DispatchTransitions: 13,
} as const;

export const FunctionalEffectCoreStatus = {
  Pending: 0,
  Complete: 1,
  Diagnostic: 2,
  Exhausted: 3,
} as const;

export const FunctionalEffectCoreDiagnostic = {
  None: 0,
  InvalidNode: 1,
  InvalidOperation: 2,
  TypeMismatch: 3,
  NonLinear: 4,
} as const;

export const FUNCTIONAL_EFFECT_CORE_SHADER = /* wgsl */ `
const NO_INDEX: u32 = 0xffffffffu;
const PURE: u32 = 0xffffffffu;

const TAG_RETURN: u32 = 1u;
const TAG_HOST_CALL: u32 = 2u;
const TAG_PERFORM: u32 = 3u;
const TAG_BIND: u32 = 4u;
const TAG_BRANCH: u32 = 5u;
const TAG_HANDLE: u32 = 6u;

const TYPE_INTEGER: u32 = 1u;
const TYPE_BOOLEAN: u32 = 2u;
const TYPE_UNIT: u32 = 3u;

const OPERATION_LOCAL: u32 = 1u;
const OPERATION_HOST: u32 = 2u;

const STATUS_PENDING: u32 = 0u;
const STATUS_COMPLETE: u32 = 1u;
const STATUS_DIAGNOSTIC: u32 = 2u;
const STATUS_EXHAUSTED: u32 = 3u;

const DIAGNOSTIC_INVALID_NODE: u32 = 1u;
const DIAGNOSTIC_INVALID_OPERATION: u32 = 2u;
const DIAGNOSTIC_TYPE_MISMATCH: u32 = 3u;
const DIAGNOSTIC_NON_LINEAR: u32 = 4u;

struct State {
  node_count: u32,
  operation_count: u32,
  root_node: u32,
  cursor: u32,
  phase: u32,
  status: u32,
  diagnostic_code: u32,
  diagnostic_node: u32,
  transitions: u32,
  maximum_transitions: u32,
  maximum_transitions_per_dispatch: u32,
  root_type: u32,
  root_effects: u32,
  dispatch_transitions: u32,
}

@group(0) @binding(0) var<storage, read> nodes: array<u32>;
@group(0) @binding(1) var<storage, read> operations: array<u32>;
@group(0) @binding(2) var<storage, read_write> results: array<u32>;
@group(0) @binding(3) var<storage, read_write> parents: array<u32>;
@group(0) @binding(4) var<storage, read_write> state: State;

fn node_word(node: u32, word: u32) -> u32 {
  return nodes[node * 8u + word];
}

fn operation_word(operation: u32, word: u32) -> u32 {
  return operations[operation * 4u + word];
}

fn result_type(node: u32) -> u32 {
  return results[node * 2u];
}

fn result_effects(node: u32) -> u32 {
  return results[node * 2u + 1u];
}

fn scalar_type_valid(value: u32) -> bool {
  return value == TYPE_INTEGER || value == TYPE_BOOLEAN || value == TYPE_UNIT;
}

fn fail(code: u32, node: u32) {
  state.status = STATUS_DIAGNOSTIC;
  state.diagnostic_code = code;
  state.diagnostic_node = node;
}

fn child_valid(parent: u32, child: u32) -> bool {
  return child != NO_INDEX && child < state.node_count && child > parent;
}

fn add_parent(child: u32) {
  parents[child] = parents[child] + 1u;
}

fn operation_effect(operation: u32) -> u32 {
  let bit = operation_word(operation, 2u);
  if bit == PURE { return 0u; }
  return 1u << bit;
}

fn infer_transition() {
  let node = state.cursor;
  let tag = node_word(node, 0u);
  let payload = node_word(node, 1u);
  let child0 = node_word(node, 2u);
  let child1 = node_word(node, 3u);
  let annotated_type = node_word(node, 4u);

  var inferred_type = 0u;
  var inferred_effects = 0u;

  if tag == TAG_RETURN {
    if !scalar_type_valid(annotated_type) || child0 != NO_INDEX || child1 != NO_INDEX {
      fail(DIAGNOSTIC_INVALID_NODE, node);
      return;
    }
    inferred_type = annotated_type;
  } else if tag == TAG_HOST_CALL || tag == TAG_PERFORM {
    if payload >= state.operation_count || child0 != NO_INDEX || child1 != NO_INDEX {
      fail(DIAGNOSTIC_INVALID_OPERATION, node);
      return;
    }
    let expected_kind = select(OPERATION_LOCAL, OPERATION_HOST, tag == TAG_HOST_CALL);
    if operation_word(payload, 3u) != expected_kind {
      fail(DIAGNOSTIC_INVALID_OPERATION, node);
      return;
    }
    if annotated_type != operation_word(payload, 0u) {
      fail(DIAGNOSTIC_TYPE_MISMATCH, node);
      return;
    }
    inferred_type = operation_word(payload, 1u);
    inferred_effects = operation_effect(payload);
  } else if tag == TAG_BIND {
    if !child_valid(node, child0) || !child_valid(node, child1) {
      fail(DIAGNOSTIC_INVALID_NODE, node);
      return;
    }
    add_parent(child0);
    add_parent(child1);
    inferred_type = result_type(child1);
    inferred_effects = result_effects(child0) | result_effects(child1);
  } else if tag == TAG_BRANCH {
    if annotated_type != TYPE_BOOLEAN || !child_valid(node, child0) || !child_valid(node, child1) {
      fail(DIAGNOSTIC_INVALID_NODE, node);
      return;
    }
    add_parent(child0);
    add_parent(child1);
    if result_type(child0) != result_type(child1) {
      fail(DIAGNOSTIC_TYPE_MISMATCH, node);
      return;
    }
    inferred_type = result_type(child0);
    inferred_effects = result_effects(child0) | result_effects(child1);
  } else if tag == TAG_HANDLE {
    if payload >= state.operation_count || operation_word(payload, 3u) != OPERATION_LOCAL ||
       !child_valid(node, child0) || child1 != NO_INDEX {
      fail(DIAGNOSTIC_INVALID_OPERATION, node);
      return;
    }
    add_parent(child0);
    inferred_type = result_type(child0);
    inferred_effects = result_effects(child0) & ~operation_effect(payload);
  } else {
    fail(DIAGNOSTIC_INVALID_NODE, node);
    return;
  }

  results[node * 2u] = inferred_type;
  results[node * 2u + 1u] = inferred_effects;
  if node == 0u {
    state.phase = 1u;
    state.cursor = 0u;
  } else {
    state.cursor = node - 1u;
  }
}

fn linear_transition() {
  let node = state.cursor;
  let expected = select(1u, 0u, node == state.root_node);
  if parents[node] != expected {
    fail(DIAGNOSTIC_NON_LINEAR, node);
    return;
  }
  if node + 1u == state.node_count {
    state.root_type = result_type(state.root_node);
    state.root_effects = result_effects(state.root_node);
    state.status = STATUS_COMPLETE;
  } else {
    state.cursor = node + 1u;
  }
}

@compute @workgroup_size(1)
fn verify_functional_effect_core() {
  if state.status != STATUS_PENDING { return; }
  state.dispatch_transitions = 0u;
  for (var step = 0u; step < state.maximum_transitions_per_dispatch; step = step + 1u) {
    if state.status != STATUS_PENDING { break; }
    if state.transitions >= state.maximum_transitions {
      state.status = STATUS_EXHAUSTED;
      break;
    }
    if state.phase == 0u { infer_transition(); }
    else { linear_transition(); }
    state.transitions = state.transitions + 1u;
    state.dispatch_transitions = state.dispatch_transitions + 1u;
  }
}
`;
