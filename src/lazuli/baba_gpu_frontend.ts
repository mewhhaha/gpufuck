import type { CompactFrontendProgram, decodeGpuFrontendPlan } from "@mewhhaha/baba/runtime/webgpu";

import type { BabaRuleCursor, BabaTokenCursor, BabaUtf16Span } from "../baba_frontend.ts";

const TOKEN_WORD_LENGTH = 4;
const NODE_WORD_LENGTH = 8;
const EDGE_WORD_LENGTH = 4;
const TRIVIA_TERMINAL = -1;
const TOKEN_TARGET = 0;
const NODE_TARGET = 1;

// These nullable-tail rules contribute skipped trivia to spans consumed by Lazuli lowering.
const TRAILING_NULLABLE_RULES = new Set([
  "additive",
  "call",
  "comparison",
  "const_descriptor_field_list",
  "const_parameter_field_list",
  "constructor_declaration",
  "constructor_field_list",
  "data_constructors",
  "equality",
  "identifier_list",
  "list_values",
  "multiplicative",
  "named",
  "record_fields",
  "source_type",
]);

type GpuFrontendPlan = ReturnType<typeof decodeGpuFrontendPlan>;
type BabaCursor = BabaRuleCursor | BabaTokenCursor;

interface CompactEdge {
  readonly field: number;
  readonly value: BabaCursor;
}

export function compactLazuliProgramCursor(
  source: string,
  program: CompactFrontendProgram,
  plan: GpuFrontendPlan,
): BabaRuleCursor {
  assertRecordAlignment("token", program.tokens, TOKEN_WORD_LENGTH);
  assertRecordAlignment("node", program.nodes, NODE_WORD_LENGTH);
  assertRecordAlignment("edge", program.edges, EDGE_WORD_LENGTH);

  const nodeCount = program.nodes.length / NODE_WORD_LENGTH;
  if (nodeCount === 0) {
    throw new Error("Baba compact frontend returned no root node.");
  }

  const ruleNameById = new Map(plan.islands.map((island) => [island.ruleId, island.ruleName]));
  const fieldIdByName = compactFieldIds(plan);
  const trailingTriviaEndByOffset = trailingTriviaEnds(program);
  const cursors: CompactRuleCursor[] = [];
  for (let nodeId = 0; nodeId < nodeCount; nodeId += 1) {
    cursors.push(
      new CompactRuleCursor(
        source,
        program,
        nodeId,
        ruleNameById,
        fieldIdByName,
        trailingTriviaEndByOffset,
        cursors,
      ),
    );
  }

  for (const cursor of cursors) cursor.connectEdges();
  const edgeCount = program.edges.length / EDGE_WORD_LENGTH;
  const edgeOwners = new Uint8Array(edgeCount);
  const incomingNodeEdges = new Uint32Array(nodeCount);
  for (let nodeId = 0; nodeId < nodeCount; nodeId += 1) {
    const nodeOffset = nodeId * NODE_WORD_LENGTH;
    const edgeStart = requiredWord(program.nodes, nodeOffset + 4, "edge start", nodeId);
    const nodeEdgeCount = requiredWord(program.nodes, nodeOffset + 5, "edge count", nodeId);
    for (let edgeId = edgeStart; edgeId < edgeStart + nodeEdgeCount; edgeId += 1) {
      if (edgeOwners[edgeId] !== 0) {
        throw new Error(`Baba compact frontend edge ${edgeId} belongs to multiple nodes.`);
      }
      edgeOwners[edgeId] = 1;
      const edgeOffset = edgeId * EDGE_WORD_LENGTH;
      if (program.edges[edgeOffset + 2] === NODE_TARGET) {
        const target = requiredWord(program.edges, edgeOffset + 3, "edge target", edgeId);
        incomingNodeEdges[target]! += 1;
      }
    }
  }
  const unownedEdge = edgeOwners.findIndex((owner) => owner === 0);
  if (unownedEdge !== -1) {
    throw new Error(`Baba compact frontend edge ${unownedEdge} belongs to no node.`);
  }
  if (incomingNodeEdges[0] !== 0) {
    throw new Error(`Baba compact frontend root has ${incomingNodeEdges[0]} incoming node edges.`);
  }
  for (let nodeId = 1; nodeId < nodeCount; nodeId += 1) {
    if (incomingNodeEdges[nodeId] !== 1) {
      throw new Error(
        `Baba compact frontend node ${nodeId} has ${
          incomingNodeEdges[nodeId]
        } incoming node edges; ` +
          "expected exactly one.",
      );
    }
  }
  correctCompactSpans(cursors);

  const root = cursors[0];
  if (root === undefined || root.name !== "module") {
    throw new Error(
      `Baba compact frontend root is ${JSON.stringify(root?.name)}; expected "module".`,
    );
  }
  return root;
}

class CompactRuleCursor implements BabaRuleCursor {
  readonly type = "rule";
  readonly name: string;
  span: BabaUtf16Span;
  #edges: readonly CompactEdge[] = [];

  constructor(
    private readonly source: string,
    private readonly program: CompactFrontendProgram,
    private readonly nodeId: number,
    ruleNameById: ReadonlyMap<number, string>,
    private readonly fieldIdByName: ReadonlyMap<string, number>,
    private readonly trailingTriviaEndByOffset: ReadonlyMap<number, number>,
    private readonly cursors: readonly CompactRuleCursor[],
  ) {
    const nodeOffset = nodeId * NODE_WORD_LENGTH;
    const ruleId = requiredWord(program.nodes, nodeOffset, "node rule", nodeId);
    const name = ruleNameById.get(ruleId);
    if (name === undefined) {
      throw new Error(`Baba compact frontend node ${nodeId} has unknown rule id ${ruleId}.`);
    }
    this.name = name;
    this.span = compactSpan(
      source,
      requiredWord(program.nodes, nodeOffset + 2, "node start", nodeId),
      requiredWord(program.nodes, nodeOffset + 3, "node end", nodeId),
      `node ${nodeId}`,
    );
  }

  connectEdges(): void {
    const nodeOffset = this.nodeId * NODE_WORD_LENGTH;
    const edgeStart = requiredWord(this.program.nodes, nodeOffset + 4, "edge start", this.nodeId);
    const edgeCount = requiredWord(this.program.nodes, nodeOffset + 5, "edge count", this.nodeId);
    if (edgeStart < 0 || edgeCount < 0 || edgeStart + edgeCount > this.edgeRecordCount) {
      throw new Error(
        `Baba compact frontend node ${this.nodeId} has edge range ` +
          `[${edgeStart}, ${edgeStart + edgeCount}) outside ${this.edgeRecordCount} records.`,
      );
    }

    const edges: CompactEdge[] = [];
    for (let localOrdinal = 0; localOrdinal < edgeCount; localOrdinal += 1) {
      const edgeId = edgeStart + localOrdinal;
      const edgeOffset = edgeId * EDGE_WORD_LENGTH;
      const field = requiredWord(this.program.edges, edgeOffset, "edge field", edgeId);
      const ordinal = requiredWord(this.program.edges, edgeOffset + 1, "edge ordinal", edgeId);
      const category = requiredWord(this.program.edges, edgeOffset + 2, "edge category", edgeId);
      const target = requiredWord(this.program.edges, edgeOffset + 3, "edge target", edgeId);
      if (ordinal !== localOrdinal) {
        throw new Error(
          `Baba compact frontend node ${this.nodeId} edge ${edgeId} has ordinal ${ordinal}; ` +
            `expected ${localOrdinal}.`,
        );
      }
      edges.push({ field, value: this.edgeValue(edgeId, category, target) });
    }
    this.#edges = edges;
  }

  correctSpan(): void {
    let end = this.span.end;
    for (const edge of this.#edges) {
      end = Math.max(end, edge.value.span.end);
    }
    const presentOptionalSuffix = this.name === "named" &&
      this.#edges.some((edge) => edge.value.type === "rule" && edge.value.name === "named_suffix");
    if (TRAILING_NULLABLE_RULES.has(this.name) && !presentOptionalSuffix) {
      end = this.trailingTriviaEndByOffset.get(end) ?? end;
    }
    this.span = compactSpan(this.source, this.span.start, end, `node ${this.nodeId}`);
  }

  children(): readonly BabaCursor[] {
    return this.#edges.map((edge) => edge.value);
  }

  field(name: string): BabaCursor | undefined {
    const field = this.fieldId(name);
    return this.#edges.find((edge) => edge.field === field)?.value;
  }

  fieldArray(name: string): readonly BabaCursor[] {
    const field = this.fieldId(name);
    return this.#edges.filter((edge) => edge.field === field).map((edge) => edge.value);
  }

  private get edgeRecordCount(): number {
    return this.program.edges.length / EDGE_WORD_LENGTH;
  }

  private edgeValue(edgeId: number, category: number, target: number): BabaCursor {
    if (category === NODE_TARGET) {
      const cursor = this.cursors[target];
      if (cursor === undefined) {
        throw new Error(
          `Baba compact frontend edge ${edgeId} targets missing node ${target}; ` +
            `node count is ${this.cursors.length}.`,
        );
      }
      return cursor;
    }
    if (category !== TOKEN_TARGET) {
      throw new Error(
        `Baba compact frontend edge ${edgeId} has unknown target category ${category}.`,
      );
    }

    const tokenCount = this.program.tokens.length / TOKEN_WORD_LENGTH;
    if (target < 0 || target >= tokenCount) {
      throw new Error(
        `Baba compact frontend edge ${edgeId} targets missing token ${target}; ` +
          `token count is ${tokenCount}.`,
      );
    }
    const tokenOffset = target * TOKEN_WORD_LENGTH;
    const span = compactSpan(
      this.source,
      requiredWord(this.program.tokens, tokenOffset + 1, "token start", target),
      requiredWord(this.program.tokens, tokenOffset + 2, "token end", target),
      `token ${target}`,
    );
    return {
      type: "token",
      text: this.source.slice(span.start, span.end),
      span,
    };
  }

  private fieldId(name: string): number {
    const field = this.fieldIdByName.get(name);
    if (field !== undefined) return field;
    throw new Error(
      `Baba compact frontend plan has no field named ${JSON.stringify(name)} ` +
        `while reading ${this.name} node ${this.nodeId}.`,
    );
  }
}

function correctCompactSpans(cursors: readonly CompactRuleCursor[]): void {
  const states = new Map<CompactRuleCursor, "visiting" | "complete">();
  const visit = (cursor: CompactRuleCursor): void => {
    const state = states.get(cursor);
    if (state === "complete") return;
    if (state === "visiting") {
      throw new Error(`Baba compact frontend contains a cycle through ${cursor.name}.`);
    }
    states.set(cursor, "visiting");
    for (const child of cursor.children()) {
      if (child instanceof CompactRuleCursor) visit(child);
    }
    cursor.correctSpan();
    states.set(cursor, "complete");
  };
  for (const cursor of cursors) visit(cursor);
}

function compactFieldIds(plan: GpuFrontendPlan): ReadonlyMap<string, number> {
  const fields = new Map<string, number>();
  for (const recipe of plan.semanticRecipes) {
    for (const field of recipe.fields) {
      const existing = fields.get(field.source);
      if (existing !== undefined && existing !== field.field) {
        throw new Error(
          `Baba compact frontend field ${JSON.stringify(field.source)} has ids ` +
            `${existing} and ${field.field}.`,
        );
      }
      fields.set(field.source, field.field);
    }
  }
  return fields;
}

function trailingTriviaEnds(program: CompactFrontendProgram): ReadonlyMap<number, number> {
  const ends = new Map<number, number>();
  const tokenCount = program.tokens.length / TOKEN_WORD_LENGTH;
  for (let tokenId = tokenCount - 1; tokenId >= 0; tokenId -= 1) {
    const tokenOffset = tokenId * TOKEN_WORD_LENGTH;
    const terminal = requiredWord(program.tokens, tokenOffset, "token terminal", tokenId);
    if (terminal !== TRIVIA_TERMINAL) continue;

    const start = requiredWord(program.tokens, tokenOffset + 1, "token start", tokenId);
    const end = requiredWord(program.tokens, tokenOffset + 2, "token end", tokenId);
    ends.set(start, ends.get(end) ?? end);
  }
  return ends;
}

function compactSpan(
  source: string,
  start: number,
  end: number,
  subject: string,
): BabaUtf16Span {
  if (start < 0 || end < start || end > source.length) {
    throw new Error(
      `Baba compact frontend ${subject} span [${start}, ${end}) ` +
        `is outside source length ${source.length}.`,
    );
  }
  return { start, end };
}

function assertRecordAlignment(name: string, words: Int32Array, wordLength: number): void {
  if (words.length % wordLength !== 0) {
    throw new Error(
      `Baba compact frontend ${name} array has ${words.length} words; ` +
        `expected a multiple of ${wordLength}.`,
    );
  }
}

function requiredWord(
  words: Int32Array,
  index: number,
  name: string,
  record: number,
): number {
  const value = words[index];
  if (value === undefined) {
    throw new Error(`Baba compact frontend ${name} is missing from record ${record}.`);
  }
  return value;
}
