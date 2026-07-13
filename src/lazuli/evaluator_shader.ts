import {
  LAZULI_CONSTRUCTOR_WORD_LENGTH,
  LAZULI_DEFINITION_WORD_LENGTH,
  LAZULI_MAXIMUM_CONSTRUCTOR_ARITY,
  LAZULI_NO_INDEX,
  LAZULI_NODE_WORD_LENGTH,
  LazuliBinaryOperator,
  LazuliCoreTag,
  LazuliUnaryOperator,
} from "./abi.ts";

export const LAZULI_EVALUATOR_SHADER = /* wgsl */ `
struct CoreNode {
  tag: u32,
  payload: u32,
  child0: u32,
  child1: u32,
  child2: u32,
  source_offset: u32,
  reserved0: u32,
  reserved1: u32,
}

struct Definition {
  symbol: u32,
  root_node: u32,
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

struct HeapSlot {
  kind: u32,
  state: u32,
  field0: u32,
  field1: u32,
  field2: u32,
  field3: u32,
  reserved0: u32,
  reserved1: u32,
}

struct ContinuationFrame {
  kind: u32,
  field0: u32,
  field1: u32,
  field2: u32,
  field3: u32,
  field4: u32,
  source_offset: u32,
  reserved: u32,
}

struct EvaluationState {
  node_count: u32,
  definition_count: u32,
  entry_definition: u32,
  maximum_steps: u32,
  heap_capacity: u32,
  stack_capacity: u32,
  status: u32,
  fault_code: u32,
  fault_source_offset: u32,
  fault_detail: u32,
  mode: u32,
  expression: u32,
  environment: u32,
  value_tag: u32,
  value_payload: u32,
  current_source_offset: u32,
  steps: u32,
  allocations: u32,
  peak_stack: u32,
  thunk_evaluations: u32,
  heap_top: u32,
  stack_top: u32,
  local_environment: u32,
  local_depth: u32,
  local_lookup_active: u32,
  constructor_count: u32,
  type_count: u32,
  case_arm: u32,
  case_pattern: u32,
  case_field: u32,
  case_environment: u32,
  case_remaining: u32,
  case_constructor: u32,
  case_source_offset: u32,
  maximum_steps_per_dispatch: u32,
  initialization_definition: u32,
}

@group(0) @binding(0)
var<storage, read> nodes: array<CoreNode>;

@group(0) @binding(1)
var<storage, read> definitions: array<Definition>;

@group(0) @binding(2)
var<storage, read_write> heap: array<HeapSlot>;

@group(0) @binding(3)
var<storage, read_write> continuation_stack: array<ContinuationFrame>;

@group(0) @binding(4)
var<storage, read_write> global_thunks: array<u32>;

@group(0) @binding(5)
var<storage, read_write> evaluation: EvaluationState;

@group(0) @binding(6)
var<storage, read> constructors: array<Constructor>;

const NO_INDEX: u32 = ${LAZULI_NO_INDEX}u;
const NODE_WORD_LENGTH: u32 = ${LAZULI_NODE_WORD_LENGTH}u;
const DEFINITION_WORD_LENGTH: u32 = ${LAZULI_DEFINITION_WORD_LENGTH}u;
const CONSTRUCTOR_WORD_LENGTH: u32 = ${LAZULI_CONSTRUCTOR_WORD_LENGTH}u;
const MAXIMUM_CONSTRUCTOR_ARITY: u32 = ${LAZULI_MAXIMUM_CONSTRUCTOR_ARITY}u;

const STATUS_UNINITIALIZED: u32 = 0u;
const STATUS_PENDING: u32 = 1u;
const STATUS_COMPLETE: u32 = 2u;
const STATUS_FAULT: u32 = 3u;

const FAULT_BAD_MODULE: u32 = 1u;
const FAULT_OUT_OF_FUEL: u32 = 2u;
const FAULT_OUT_OF_HEAP: u32 = 3u;
const FAULT_STACK_OVERFLOW: u32 = 4u;
const FAULT_BLACKHOLE: u32 = 5u;
const FAULT_TYPE_ERROR: u32 = 6u;
const FAULT_DIVIDE_BY_ZERO: u32 = 7u;
const FAULT_NON_EXHAUSTIVE_CASE: u32 = 8u;

const MODE_EVAL: u32 = 1u;
const MODE_ENTER_THUNK: u32 = 2u;
const MODE_RETURN: u32 = 3u;
const MODE_CASE_ARM: u32 = 4u;
const MODE_CASE_BIND: u32 = 5u;
const MODE_INITIALIZE_GLOBAL: u32 = 6u;

const VALUE_INTEGER: u32 = 1u;
const VALUE_BOOLEAN: u32 = 2u;
const VALUE_CLOSURE: u32 = 3u;
const VALUE_CONSTRUCTOR_PARTIAL: u32 = 4u;
const VALUE_CONSTRUCTOR: u32 = 5u;

const HEAP_THUNK: u32 = 1u;
const HEAP_ENVIRONMENT: u32 = 2u;
const HEAP_CLOSURE: u32 = 3u;
const HEAP_CONSTRUCTOR_PARTIAL: u32 = 4u;
const HEAP_CONSTRUCTOR_FIELD: u32 = 5u;
const HEAP_CONSTRUCTOR: u32 = 6u;

const THUNK_UNEVALUATED: u32 = 0u;
const THUNK_EVALUATING: u32 = 1u;
const THUNK_EVALUATED: u32 = 2u;

const FRAME_UPDATE: u32 = 1u;
const FRAME_APPLY: u32 = 2u;
const FRAME_IF: u32 = 3u;
const FRAME_UNARY: u32 = 4u;
const FRAME_BINARY_LEFT: u32 = 5u;
const FRAME_BINARY_RIGHT: u32 = 6u;
const FRAME_CASE: u32 = 7u;

const EXPECT_INTEGER: u32 = 1u;
const EXPECT_BOOLEAN: u32 = 2u;
const EXPECT_CALLABLE: u32 = 3u;
const EXPECT_CONSTRUCTOR: u32 = 4u;

const TAG_INTEGER: u32 = ${LazuliCoreTag.Integer}u;
const TAG_BOOLEAN: u32 = ${LazuliCoreTag.Boolean}u;
const TAG_LET: u32 = ${LazuliCoreTag.Let}u;
const TAG_IF: u32 = ${LazuliCoreTag.If}u;
const TAG_LAMBDA: u32 = ${LazuliCoreTag.Lambda}u;
const TAG_APPLY: u32 = ${LazuliCoreTag.Apply}u;
const TAG_UNARY: u32 = ${LazuliCoreTag.Unary}u;
const TAG_BINARY: u32 = ${LazuliCoreTag.Binary}u;
const TAG_CASE: u32 = ${LazuliCoreTag.Case}u;
const TAG_CASE_ARM: u32 = ${LazuliCoreTag.CaseArm}u;
const TAG_PATTERN_BIND: u32 = ${LazuliCoreTag.PatternBind}u;
const TAG_LOCAL: u32 = ${LazuliCoreTag.Local}u;
const TAG_GLOBAL: u32 = ${LazuliCoreTag.Global}u;
const TAG_CONSTRUCTOR: u32 = ${LazuliCoreTag.Constructor}u;
const TAG_LET_REC: u32 = ${LazuliCoreTag.LetRec}u;

const UNARY_NEGATE: u32 = ${LazuliUnaryOperator.Negate}u;
const BINARY_EQUAL: u32 = ${LazuliBinaryOperator.Equal}u;
const BINARY_NOT_EQUAL: u32 = ${LazuliBinaryOperator.NotEqual}u;
const BINARY_LESS: u32 = ${LazuliBinaryOperator.Less}u;
const BINARY_LESS_EQUAL: u32 = ${LazuliBinaryOperator.LessEqual}u;
const BINARY_GREATER: u32 = ${LazuliBinaryOperator.Greater}u;
const BINARY_GREATER_EQUAL: u32 = ${LazuliBinaryOperator.GreaterEqual}u;
const BINARY_ADD: u32 = ${LazuliBinaryOperator.Add}u;
const BINARY_SUBTRACT: u32 = ${LazuliBinaryOperator.Subtract}u;
const BINARY_MULTIPLY: u32 = ${LazuliBinaryOperator.Multiply}u;
const BINARY_DIVIDE: u32 = ${LazuliBinaryOperator.Divide}u;

fn fail(code: u32, source_offset: u32, detail: u32) {
  evaluation.status = STATUS_FAULT;
  evaluation.fault_code = code;
  evaluation.fault_source_offset = source_offset;
  evaluation.fault_detail = detail;
}

fn fail_bad_module(detail: u32) {
  fail(FAULT_BAD_MODULE, evaluation.current_source_offset, detail);
}

fn valid_node(index: u32) -> bool {
  return index != NO_INDEX && index < evaluation.node_count && index < arrayLength(&nodes);
}

fn valid_core_child(parent_index: u32, child_index: u32) -> bool {
  return valid_node(child_index) && child_index > parent_index;
}

fn valid_optional_core_child(parent_index: u32, child_index: u32) -> bool {
  return child_index == NO_INDEX || valid_core_child(parent_index, child_index);
}

fn children_are_absent(node: CoreNode) -> bool {
  return node.child0 == NO_INDEX && node.child1 == NO_INDEX && node.child2 == NO_INDEX;
}

fn valid_heap(index: u32) -> bool {
  return index != NO_INDEX && index < evaluation.heap_top &&
    index < evaluation.heap_capacity && index < arrayLength(&heap);
}

fn valid_constructor(index: u32) -> bool {
  if index == NO_INDEX || index >= evaluation.constructor_count ||
      index >= arrayLength(&constructors) {
    return false;
  }
  let constructor = constructors[index];
  return constructor.type_index < evaluation.type_count &&
    constructor.arity <= MAXIMUM_CONSTRUCTOR_ARITY;
}

fn valid_heap_value(value_tag: u32, value_payload: u32) -> bool {
  switch value_tag {
    case VALUE_INTEGER: {
      return true;
    }
    case VALUE_BOOLEAN: {
      return value_payload <= 1u;
    }
    case VALUE_CLOSURE: {
      if !valid_heap(value_payload) {
        return false;
      }
      let closure = heap[value_payload];
      return closure.kind == HEAP_CLOSURE && valid_node(closure.field0);
    }
    case VALUE_CONSTRUCTOR_PARTIAL: {
      if !valid_heap(value_payload) {
        return false;
      }
      let partial = heap[value_payload];
      if partial.kind != HEAP_CONSTRUCTOR_PARTIAL || !valid_constructor(partial.field0) {
        return false;
      }
      let constructor = constructors[partial.field0];
      if constructor.arity == 0u || partial.field2 >= constructor.arity {
        return false;
      }
      if partial.field2 == 0u {
        return partial.field1 == NO_INDEX;
      }
      if !valid_heap(partial.field1) {
        return false;
      }
      return heap[partial.field1].kind == HEAP_CONSTRUCTOR_FIELD;
    }
    case VALUE_CONSTRUCTOR: {
      if !valid_heap(value_payload) {
        return false;
      }
      let value = heap[value_payload];
      if value.kind != HEAP_CONSTRUCTOR || !valid_constructor(value.field0) {
        return false;
      }
      let constructor = constructors[value.field0];
      if value.field2 != constructor.arity {
        return false;
      }
      if constructor.arity == 0u {
        return value.field1 == NO_INDEX;
      }
      if !valid_heap(value.field1) {
        return false;
      }
      return heap[value.field1].kind == HEAP_CONSTRUCTOR_FIELD;
    }
    default: {
      return false;
    }
  }
}

fn allocate_heap_slot(kind: u32, source_offset: u32) -> u32 {
  if evaluation.heap_top >= evaluation.heap_capacity || evaluation.heap_top >= arrayLength(&heap) {
    fail(FAULT_OUT_OF_HEAP, source_offset, evaluation.heap_capacity);
    return NO_INDEX;
  }

  let index = evaluation.heap_top;
  evaluation.heap_top += 1u;
  evaluation.allocations += 1u;
  heap[index] = HeapSlot(kind, 0u, 0u, 0u, 0u, 0u, 0u, 0u);
  return index;
}

fn push_frame(frame: ContinuationFrame) -> bool {
  if evaluation.stack_top >= evaluation.stack_capacity ||
      evaluation.stack_top >= arrayLength(&continuation_stack) {
    fail(FAULT_STACK_OVERFLOW, frame.source_offset, evaluation.stack_capacity);
    return false;
  }

  continuation_stack[evaluation.stack_top] = frame;
  evaluation.stack_top += 1u;
  evaluation.peak_stack = max(evaluation.peak_stack, evaluation.stack_top);
  return true;
}

fn pop_frame() -> ContinuationFrame {
  if evaluation.stack_top == 0u {
    fail_bad_module(evaluation.stack_top);
    return ContinuationFrame(0u, 0u, 0u, 0u, 0u, 0u, NO_INDEX, 0u);
  }

  let index = evaluation.stack_top - 1u;
  if index >= evaluation.stack_capacity || index >= arrayLength(&continuation_stack) {
    fail_bad_module(index);
    return ContinuationFrame(0u, 0u, 0u, 0u, 0u, 0u, NO_INDEX, 0u);
  }
  evaluation.stack_top = index;
  return continuation_stack[index];
}

fn valid_binary_operator(operator_code: u32) -> bool {
  return operator_code >= BINARY_EQUAL && operator_code <= BINARY_DIVIDE;
}

fn return_value(tag: u32, payload: u32) {
  evaluation.value_tag = tag;
  evaluation.value_payload = payload;
  evaluation.mode = MODE_RETURN;
}

fn evaluate_expression(expression: u32, environment: u32) {
  evaluation.expression = expression;
  evaluation.environment = environment;
  evaluation.mode = MODE_EVAL;
}

fn evaluate_node() {
  if !valid_node(evaluation.expression) {
    fail_bad_module(evaluation.expression);
    return;
  }

  let node = nodes[evaluation.expression];
  evaluation.current_source_offset = node.source_offset;

  switch node.tag {
    case TAG_INTEGER: {
      if !children_are_absent(node) {
        fail_bad_module(evaluation.expression);
        return;
      }
      return_value(VALUE_INTEGER, node.payload);
    }
    case TAG_BOOLEAN: {
      if node.payload > 1u || !children_are_absent(node) {
        fail_bad_module(node.payload);
        return;
      }
      return_value(VALUE_BOOLEAN, node.payload);
    }
    case TAG_LET: {
      if !valid_core_child(evaluation.expression, node.child0) ||
          !valid_core_child(evaluation.expression, node.child1) || node.child2 != NO_INDEX {
        fail_bad_module(evaluation.expression);
        return;
      }

      let thunk_index = allocate_heap_slot(HEAP_THUNK, node.source_offset);
      if thunk_index == NO_INDEX {
        return;
      }
      heap[thunk_index].state = THUNK_UNEVALUATED;
      heap[thunk_index].field0 = node.child0;
      heap[thunk_index].field1 = evaluation.environment;

      let environment_index = allocate_heap_slot(HEAP_ENVIRONMENT, node.source_offset);
      if environment_index == NO_INDEX {
        return;
      }
      heap[environment_index].field0 = evaluation.environment;
      heap[environment_index].field1 = thunk_index;
      evaluate_expression(node.child1, environment_index);
    }
    case TAG_LET_REC: {
      if !valid_core_child(evaluation.expression, node.child0) ||
          !valid_core_child(evaluation.expression, node.child1) || node.child2 != NO_INDEX {
        fail_bad_module(evaluation.expression);
        return;
      }
      if nodes[node.child0].tag != TAG_LAMBDA {
        fail_bad_module(evaluation.expression);
        return;
      }

      let thunk_index = allocate_heap_slot(HEAP_THUNK, node.source_offset);
      if thunk_index == NO_INDEX {
        return;
      }
      let environment_index = allocate_heap_slot(HEAP_ENVIRONMENT, node.source_offset);
      if environment_index == NO_INDEX {
        return;
      }

      heap[environment_index].field0 = evaluation.environment;
      heap[environment_index].field1 = thunk_index;
      heap[thunk_index].state = THUNK_UNEVALUATED;
      heap[thunk_index].field0 = node.child0;
      heap[thunk_index].field1 = environment_index;
      evaluate_expression(node.child1, environment_index);
    }
    case TAG_IF: {
      if !valid_core_child(evaluation.expression, node.child0) ||
          !valid_core_child(evaluation.expression, node.child1) ||
          !valid_core_child(evaluation.expression, node.child2) {
        fail_bad_module(evaluation.expression);
        return;
      }
      let frame = ContinuationFrame(
        FRAME_IF,
        node.child1,
        node.child2,
        evaluation.environment,
        0u,
        0u,
        node.source_offset,
        0u,
      );
      if !push_frame(frame) {
        return;
      }
      evaluate_expression(node.child0, evaluation.environment);
    }
    case TAG_LAMBDA: {
      if !valid_core_child(evaluation.expression, node.child0) || node.child1 != NO_INDEX ||
          node.child2 != NO_INDEX {
        fail_bad_module(evaluation.expression);
        return;
      }
      let closure_index = allocate_heap_slot(HEAP_CLOSURE, node.source_offset);
      if closure_index == NO_INDEX {
        return;
      }
      heap[closure_index].field0 = node.child0;
      heap[closure_index].field1 = evaluation.environment;
      return_value(VALUE_CLOSURE, closure_index);
    }
    case TAG_APPLY: {
      if !valid_core_child(evaluation.expression, node.child0) ||
          !valid_core_child(evaluation.expression, node.child1) || node.child2 != NO_INDEX {
        fail_bad_module(evaluation.expression);
        return;
      }
      let frame = ContinuationFrame(
        FRAME_APPLY,
        node.child1,
        evaluation.environment,
        0u,
        0u,
        0u,
        node.source_offset,
        0u,
      );
      if !push_frame(frame) {
        return;
      }
      evaluate_expression(node.child0, evaluation.environment);
    }
    case TAG_UNARY: {
      if node.payload != UNARY_NEGATE ||
          !valid_core_child(evaluation.expression, node.child0) || node.child1 != NO_INDEX ||
          node.child2 != NO_INDEX {
        fail_bad_module(node.payload);
        return;
      }
      let frame = ContinuationFrame(
        FRAME_UNARY,
        node.payload,
        0u,
        0u,
        0u,
        0u,
        node.source_offset,
        0u,
      );
      if !push_frame(frame) {
        return;
      }
      evaluate_expression(node.child0, evaluation.environment);
    }
    case TAG_BINARY: {
      if !valid_binary_operator(node.payload) ||
          !valid_core_child(evaluation.expression, node.child0) ||
          !valid_core_child(evaluation.expression, node.child1) || node.child2 != NO_INDEX {
        fail_bad_module(node.payload);
        return;
      }
      let frame = ContinuationFrame(
        FRAME_BINARY_LEFT,
        node.payload,
        node.child1,
        evaluation.environment,
        0u,
        0u,
        node.source_offset,
        0u,
      );
      if !push_frame(frame) {
        return;
      }
      evaluate_expression(node.child0, evaluation.environment);
    }
    case TAG_CASE: {
      if !valid_core_child(evaluation.expression, node.child0) ||
          !valid_core_child(evaluation.expression, node.child1) || node.child2 != NO_INDEX {
        fail_bad_module(evaluation.expression);
        return;
      }
      let frame = ContinuationFrame(
        FRAME_CASE,
        node.child1,
        evaluation.environment,
        0u,
        0u,
        0u,
        node.source_offset,
        0u,
      );
      if !push_frame(frame) {
        return;
      }
      evaluate_expression(node.child0, evaluation.environment);
    }
    case TAG_LOCAL: {
      if !children_are_absent(node) {
        fail_bad_module(evaluation.expression);
        return;
      }
      if evaluation.local_lookup_active == 0u {
        evaluation.local_environment = evaluation.environment;
        evaluation.local_depth = node.payload;
        evaluation.local_lookup_active = 1u;
      }
      if !valid_heap(evaluation.local_environment) {
        fail_bad_module(evaluation.local_environment);
        return;
      }
      let environment_slot = heap[evaluation.local_environment];
      if environment_slot.kind != HEAP_ENVIRONMENT {
        fail_bad_module(evaluation.local_environment);
        return;
      }
      if evaluation.local_depth == 0u {
        if !valid_heap(environment_slot.field1) {
          fail_bad_module(environment_slot.field1);
          return;
        }
        evaluation.expression = environment_slot.field1;
        evaluation.local_lookup_active = 0u;
        evaluation.mode = MODE_ENTER_THUNK;
        return;
      }
      evaluation.local_environment = environment_slot.field0;
      evaluation.local_depth -= 1u;
    }
    case TAG_GLOBAL: {
      if node.payload >= evaluation.definition_count || node.payload >= arrayLength(&global_thunks) ||
          !children_are_absent(node) {
        fail_bad_module(node.payload);
        return;
      }
      let thunk_index = global_thunks[node.payload];
      if !valid_heap(thunk_index) {
        fail_bad_module(thunk_index);
        return;
      }
      evaluation.expression = thunk_index;
      evaluation.mode = MODE_ENTER_THUNK;
    }
    case TAG_CONSTRUCTOR: {
      if !valid_constructor(node.payload) || !children_are_absent(node) {
        fail_bad_module(node.payload);
        return;
      }
      let constructor = constructors[node.payload];
      if constructor.arity == 0u {
        let value_index = allocate_heap_slot(HEAP_CONSTRUCTOR, node.source_offset);
        if value_index == NO_INDEX {
          return;
        }
        heap[value_index].field0 = node.payload;
        heap[value_index].field1 = NO_INDEX;
        heap[value_index].field2 = 0u;
        return_value(VALUE_CONSTRUCTOR, value_index);
        return;
      }

      let partial_index = allocate_heap_slot(HEAP_CONSTRUCTOR_PARTIAL, node.source_offset);
      if partial_index == NO_INDEX {
        return;
      }
      heap[partial_index].field0 = node.payload;
      heap[partial_index].field1 = NO_INDEX;
      heap[partial_index].field2 = 0u;
      return_value(VALUE_CONSTRUCTOR_PARTIAL, partial_index);
    }
    default: {
      fail_bad_module(node.tag);
    }
  }
}

fn enter_thunk() {
  let thunk_index = evaluation.expression;
  if !valid_heap(thunk_index) {
    fail_bad_module(thunk_index);
    return;
  }

  let thunk = heap[thunk_index];
  if thunk.kind != HEAP_THUNK {
    fail_bad_module(thunk_index);
    return;
  }

  switch thunk.state {
    case THUNK_UNEVALUATED: {
      if !valid_node(thunk.field0) {
        fail_bad_module(thunk.field0);
        return;
      }
      let frame = ContinuationFrame(
        FRAME_UPDATE,
        thunk_index,
        0u,
        0u,
        0u,
        0u,
        evaluation.current_source_offset,
        0u,
      );
      if !push_frame(frame) {
        return;
      }
      heap[thunk_index].state = THUNK_EVALUATING;
      evaluation.thunk_evaluations += 1u;
      evaluate_expression(thunk.field0, thunk.field1);
    }
    case THUNK_EVALUATING: {
      fail(FAULT_BLACKHOLE, evaluation.current_source_offset, thunk_index);
    }
    case THUNK_EVALUATED: {
      if !valid_heap_value(thunk.field2, thunk.field3) {
        fail_bad_module(thunk.field3);
        return;
      }
      return_value(thunk.field2, thunk.field3);
    }
    default: {
      fail_bad_module(thunk.state);
    }
  }
}

fn return_from_expression() {
  if evaluation.stack_top == 0u {
    if !valid_heap_value(evaluation.value_tag, evaluation.value_payload) {
      fail_bad_module(evaluation.value_payload);
      return;
    }
    if evaluation.value_tag == VALUE_CONSTRUCTOR {
      let value_index = evaluation.value_payload;
      let value = heap[value_index];
      evaluation.value_payload = value.field0;
    }
    evaluation.status = STATUS_COMPLETE;
    return;
  }

  let frame = pop_frame();
  if evaluation.status == STATUS_FAULT {
    return;
  }

  switch frame.kind {
    case FRAME_UPDATE: {
      if !valid_heap(frame.field0) {
        fail_bad_module(frame.field0);
        return;
      }
      let thunk = heap[frame.field0];
      if thunk.kind != HEAP_THUNK || thunk.state != THUNK_EVALUATING {
        fail_bad_module(frame.field0);
        return;
      }
      if !valid_heap_value(evaluation.value_tag, evaluation.value_payload) {
        fail_bad_module(evaluation.value_payload);
        return;
      }
      heap[frame.field0].state = THUNK_EVALUATED;
      heap[frame.field0].field2 = evaluation.value_tag;
      heap[frame.field0].field3 = evaluation.value_payload;
    }
    case FRAME_APPLY: {
      if evaluation.value_tag != VALUE_CLOSURE &&
          evaluation.value_tag != VALUE_CONSTRUCTOR_PARTIAL {
        fail(FAULT_TYPE_ERROR, frame.source_offset, EXPECT_CALLABLE);
        return;
      }
      if !valid_heap_value(evaluation.value_tag, evaluation.value_payload) {
        fail_bad_module(evaluation.value_payload);
        return;
      }
      if !valid_node(frame.field0) {
        fail_bad_module(frame.field0);
        return;
      }

      let argument_thunk = allocate_heap_slot(HEAP_THUNK, frame.source_offset);
      if argument_thunk == NO_INDEX {
        return;
      }
      heap[argument_thunk].state = THUNK_UNEVALUATED;
      heap[argument_thunk].field0 = frame.field0;
      heap[argument_thunk].field1 = frame.field1;

      if evaluation.value_tag == VALUE_CONSTRUCTOR_PARTIAL {
        let partial = heap[evaluation.value_payload];
        let constructor = constructors[partial.field0];
        let field_index = allocate_heap_slot(HEAP_CONSTRUCTOR_FIELD, frame.source_offset);
        if field_index == NO_INDEX {
          return;
        }
        heap[field_index].field0 = partial.field1;
        heap[field_index].field1 = argument_thunk;

        let applied_count = partial.field2 + 1u;
        if applied_count == constructor.arity {
          let value_index = allocate_heap_slot(HEAP_CONSTRUCTOR, frame.source_offset);
          if value_index == NO_INDEX {
            return;
          }
          heap[value_index].field0 = partial.field0;
          heap[value_index].field1 = field_index;
          heap[value_index].field2 = applied_count;
          return_value(VALUE_CONSTRUCTOR, value_index);
          return;
        }

        let next_partial = allocate_heap_slot(HEAP_CONSTRUCTOR_PARTIAL, frame.source_offset);
        if next_partial == NO_INDEX {
          return;
        }
        heap[next_partial].field0 = partial.field0;
        heap[next_partial].field1 = field_index;
        heap[next_partial].field2 = applied_count;
        return_value(VALUE_CONSTRUCTOR_PARTIAL, next_partial);
        return;
      }

      let closure = heap[evaluation.value_payload];
      let call_environment = allocate_heap_slot(HEAP_ENVIRONMENT, frame.source_offset);
      if call_environment == NO_INDEX {
        return;
      }
      heap[call_environment].field0 = closure.field1;
      heap[call_environment].field1 = argument_thunk;
      evaluate_expression(closure.field0, call_environment);
    }
    case FRAME_CASE: {
      if evaluation.value_tag != VALUE_CONSTRUCTOR {
        fail(FAULT_TYPE_ERROR, frame.source_offset, EXPECT_CONSTRUCTOR);
        return;
      }
      if !valid_heap_value(evaluation.value_tag, evaluation.value_payload) ||
          !valid_node(frame.field0) {
        fail_bad_module(evaluation.value_payload);
        return;
      }
      let value = heap[evaluation.value_payload];
      evaluation.case_arm = frame.field0;
      evaluation.case_pattern = NO_INDEX;
      evaluation.case_field = value.field1;
      evaluation.case_environment = frame.field1;
      evaluation.case_remaining = value.field2;
      evaluation.case_constructor = value.field0;
      evaluation.case_source_offset = frame.source_offset;
      evaluation.current_source_offset = frame.source_offset;
      evaluation.mode = MODE_CASE_ARM;
    }
    case FRAME_IF: {
      if evaluation.value_tag != VALUE_BOOLEAN {
        fail(FAULT_TYPE_ERROR, frame.source_offset, EXPECT_BOOLEAN);
        return;
      }
      if evaluation.value_payload > 1u || !valid_node(frame.field0) || !valid_node(frame.field1) {
        fail_bad_module(evaluation.value_payload);
        return;
      }
      let branch = select(frame.field1, frame.field0, evaluation.value_payload == 1u);
      evaluate_expression(branch, frame.field2);
    }
    case FRAME_UNARY: {
      if evaluation.value_tag != VALUE_INTEGER {
        fail(FAULT_TYPE_ERROR, frame.source_offset, EXPECT_INTEGER);
        return;
      }
      if frame.field0 != UNARY_NEGATE {
        fail_bad_module(frame.field0);
        return;
      }
      return_value(VALUE_INTEGER, 0u - evaluation.value_payload);
    }
    case FRAME_BINARY_LEFT: {
      if evaluation.value_tag != VALUE_INTEGER {
        fail(FAULT_TYPE_ERROR, frame.source_offset, EXPECT_INTEGER);
        return;
      }
      if !valid_binary_operator(frame.field0) || !valid_node(frame.field1) {
        fail_bad_module(frame.field0);
        return;
      }
      let right_frame = ContinuationFrame(
        FRAME_BINARY_RIGHT,
        frame.field0,
        evaluation.value_payload,
        0u,
        0u,
        0u,
        frame.source_offset,
        0u,
      );
      if !push_frame(right_frame) {
        return;
      }
      evaluate_expression(frame.field1, frame.field2);
    }
    case FRAME_BINARY_RIGHT: {
      if evaluation.value_tag != VALUE_INTEGER {
        fail(FAULT_TYPE_ERROR, frame.source_offset, EXPECT_INTEGER);
        return;
      }
      let left = frame.field1;
      let right = evaluation.value_payload;
      switch frame.field0 {
        case BINARY_EQUAL: {
          return_value(VALUE_BOOLEAN, select(0u, 1u, left == right));
        }
        case BINARY_NOT_EQUAL: {
          return_value(VALUE_BOOLEAN, select(0u, 1u, left != right));
        }
        case BINARY_LESS: {
          return_value(VALUE_BOOLEAN, select(0u, 1u, bitcast<i32>(left) < bitcast<i32>(right)));
        }
        case BINARY_LESS_EQUAL: {
          return_value(VALUE_BOOLEAN, select(0u, 1u, bitcast<i32>(left) <= bitcast<i32>(right)));
        }
        case BINARY_GREATER: {
          return_value(VALUE_BOOLEAN, select(0u, 1u, bitcast<i32>(left) > bitcast<i32>(right)));
        }
        case BINARY_GREATER_EQUAL: {
          return_value(VALUE_BOOLEAN, select(0u, 1u, bitcast<i32>(left) >= bitcast<i32>(right)));
        }
        case BINARY_ADD: {
          return_value(VALUE_INTEGER, left + right);
        }
        case BINARY_SUBTRACT: {
          return_value(VALUE_INTEGER, left - right);
        }
        case BINARY_MULTIPLY: {
          return_value(VALUE_INTEGER, left * right);
        }
        case BINARY_DIVIDE: {
          if right == 0u {
            fail(FAULT_DIVIDE_BY_ZERO, frame.source_offset, 0u);
            return;
          }
          if left == 0x80000000u && right == 0xffffffffu {
            return_value(VALUE_INTEGER, 0x80000000u);
            return;
          }
          return_value(VALUE_INTEGER, bitcast<u32>(bitcast<i32>(left) / bitcast<i32>(right)));
        }
        default: {
          fail_bad_module(frame.field0);
        }
      }
    }
    default: {
      fail_bad_module(frame.kind);
    }
  }
}

fn match_case_arm() {
  evaluation.current_source_offset = evaluation.case_source_offset;
  if !valid_constructor(evaluation.case_constructor) {
    fail_bad_module(evaluation.case_constructor);
    return;
  }
  if evaluation.case_arm == NO_INDEX {
    fail(
      FAULT_NON_EXHAUSTIVE_CASE,
      evaluation.case_source_offset,
      evaluation.case_constructor,
    );
    return;
  }
  if !valid_node(evaluation.case_arm) {
    fail_bad_module(evaluation.case_arm);
    return;
  }

  let arm = nodes[evaluation.case_arm];
  if arm.tag != TAG_CASE_ARM || !valid_constructor(arm.payload) ||
      !valid_core_child(evaluation.case_arm, arm.child0) ||
      !valid_optional_core_child(evaluation.case_arm, arm.child1) || arm.child2 != NO_INDEX {
    fail_bad_module(evaluation.case_arm);
    return;
  }
  if arm.payload != evaluation.case_constructor {
    evaluation.case_arm = arm.child1;
    return;
  }

  let constructor = constructors[arm.payload];
  if constructor.arity != evaluation.case_remaining {
    fail_bad_module(arm.payload);
    return;
  }
  evaluation.case_pattern = arm.child0;
  evaluation.mode = MODE_CASE_BIND;
}

fn bind_case_field() {
  evaluation.current_source_offset = evaluation.case_source_offset;
  if !valid_constructor(evaluation.case_constructor) ||
      !valid_node(evaluation.case_pattern) {
    fail_bad_module(evaluation.case_pattern);
    return;
  }

  if evaluation.case_remaining == 0u {
    if evaluation.case_field != NO_INDEX {
      fail_bad_module(evaluation.case_field);
      return;
    }
    let body = nodes[evaluation.case_pattern];
    if body.tag == TAG_PATTERN_BIND || body.tag == TAG_CASE_ARM {
      fail_bad_module(evaluation.case_pattern);
      return;
    }
    evaluate_expression(evaluation.case_pattern, evaluation.case_environment);
    return;
  }

  let binding = nodes[evaluation.case_pattern];
  if binding.tag != TAG_PATTERN_BIND ||
      !valid_core_child(evaluation.case_pattern, binding.child0) ||
      binding.child1 != NO_INDEX || binding.child2 != NO_INDEX {
    fail_bad_module(evaluation.case_pattern);
    return;
  }
  if !valid_heap(evaluation.case_field) {
    fail_bad_module(evaluation.case_field);
    return;
  }
  let field = heap[evaluation.case_field];
  if field.kind != HEAP_CONSTRUCTOR_FIELD || !valid_heap(field.field1) {
    fail_bad_module(evaluation.case_field);
    return;
  }
  let thunk = heap[field.field1];
  if thunk.kind != HEAP_THUNK {
    fail_bad_module(field.field1);
    return;
  }

  let environment_index = allocate_heap_slot(HEAP_ENVIRONMENT, evaluation.case_source_offset);
  if environment_index == NO_INDEX {
    return;
  }
  heap[environment_index].field0 = evaluation.case_environment;
  heap[environment_index].field1 = field.field1;
  evaluation.case_environment = environment_index;
  evaluation.case_pattern = binding.child0;
  evaluation.case_field = field.field0;
  evaluation.case_remaining -= 1u;
}

fn initialize_evaluation() {
  if evaluation.status != STATUS_UNINITIALIZED {
    return;
  }

  evaluation.status = STATUS_PENDING;
  evaluation.fault_code = 0u;
  evaluation.fault_source_offset = NO_INDEX;
  evaluation.fault_detail = 0u;
  evaluation.mode = MODE_INITIALIZE_GLOBAL;
  evaluation.expression = NO_INDEX;
  evaluation.environment = NO_INDEX;
  evaluation.value_tag = 0u;
  evaluation.value_payload = 0u;
  evaluation.current_source_offset = NO_INDEX;
  evaluation.steps = 0u;
  evaluation.allocations = 0u;
  evaluation.peak_stack = 0u;
  evaluation.thunk_evaluations = 0u;
  evaluation.heap_top = 0u;
  evaluation.stack_top = 0u;
  evaluation.local_environment = NO_INDEX;
  evaluation.local_depth = 0u;
  evaluation.local_lookup_active = 0u;
  evaluation.case_arm = NO_INDEX;
  evaluation.case_pattern = NO_INDEX;
  evaluation.case_field = NO_INDEX;
  evaluation.case_environment = NO_INDEX;
  evaluation.case_remaining = 0u;
  evaluation.case_constructor = NO_INDEX;
  evaluation.case_source_offset = NO_INDEX;
  evaluation.initialization_definition = 0u;

  if evaluation.node_count == 0u || evaluation.definition_count == 0u ||
      evaluation.entry_definition >= evaluation.definition_count ||
      evaluation.maximum_steps_per_dispatch == 0u ||
      evaluation.node_count > arrayLength(&nodes) ||
      evaluation.definition_count > arrayLength(&definitions) ||
      evaluation.definition_count > arrayLength(&global_thunks) ||
      evaluation.constructor_count > arrayLength(&constructors) ||
      (evaluation.constructor_count > 0u && evaluation.type_count == 0u) ||
      evaluation.heap_capacity > arrayLength(&heap) ||
      evaluation.stack_capacity > arrayLength(&continuation_stack) {
    fail_bad_module(evaluation.entry_definition);
    return;
  }
}

fn initialize_global() {
  let definition_index = evaluation.initialization_definition;
  if definition_index >= evaluation.definition_count ||
      definition_index >= arrayLength(&definitions) ||
      definition_index >= arrayLength(&global_thunks) {
    fail_bad_module(definition_index);
    return;
  }

  let definition = definitions[definition_index];
  evaluation.current_source_offset = definition.start_byte;
  if !valid_node(definition.root_node) {
    fail(FAULT_BAD_MODULE, definition.start_byte, definition.root_node);
    return;
  }

  let thunk_index = allocate_heap_slot(HEAP_THUNK, definition.start_byte);
  if thunk_index == NO_INDEX {
    return;
  }
  heap[thunk_index].state = THUNK_UNEVALUATED;
  heap[thunk_index].field0 = definition.root_node;
  heap[thunk_index].field1 = NO_INDEX;
  global_thunks[definition_index] = thunk_index;

  evaluation.initialization_definition += 1u;
  if evaluation.initialization_definition == evaluation.definition_count {
    evaluation.expression = global_thunks[evaluation.entry_definition];
    evaluation.mode = MODE_ENTER_THUNK;
  }
}

@compute @workgroup_size(1)
fn evaluate_lazuli() {
  initialize_evaluation();
  if evaluation.status != STATUS_PENDING {
    return;
  }

  let dispatch_start_steps = evaluation.steps;
  loop {
    if evaluation.status != STATUS_PENDING {
      return;
    }
    if evaluation.steps >= evaluation.maximum_steps {
      fail(FAULT_OUT_OF_FUEL, evaluation.current_source_offset, evaluation.maximum_steps);
      return;
    }
    if evaluation.steps - dispatch_start_steps >= evaluation.maximum_steps_per_dispatch {
      return;
    }
    evaluation.steps += 1u;

    switch evaluation.mode {
      case MODE_EVAL: {
        evaluate_node();
      }
      case MODE_ENTER_THUNK: {
        enter_thunk();
      }
      case MODE_RETURN: {
        return_from_expression();
      }
      case MODE_CASE_ARM: {
        match_case_arm();
      }
      case MODE_CASE_BIND: {
        bind_case_field();
      }
      case MODE_INITIALIZE_GLOBAL: {
        initialize_global();
      }
      default: {
        fail_bad_module(evaluation.mode);
      }
    }
  }
}
`;
