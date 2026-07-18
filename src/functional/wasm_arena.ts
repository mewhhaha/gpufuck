import { discardEncodedFunctionalWasmValuesFrom } from "./wasm_value_codec.ts";

interface FunctionalWasmArenaState {
  readonly mark: number;
  readonly savedFreeListHead: number;
  active: boolean;
}

export interface FunctionalWasmArena {
  readonly mark: number;
  readonly active: boolean;
  reset(): void;
}

const arenaStacks = new WeakMap<WebAssembly.Instance, FunctionalWasmArenaState[]>();
const scratchArenas = new WeakMap<WebAssembly.Instance, Map<number, FunctionalWasmArena[]>>();

export function beginFunctionalWasmArena(
  instance: WebAssembly.Instance,
): FunctionalWasmArena {
  const { heapTop, freeListHead } = allocatorGlobals(instance);
  const state: FunctionalWasmArenaState = {
    mark: Number(heapTop.value) >>> 0,
    savedFreeListHead: Number(freeListHead.value) >>> 0,
    active: true,
  };
  const stack = arenaStacks.get(instance) ?? [];
  if (!arenaStacks.has(instance)) arenaStacks.set(instance, stack);
  stack.push(state);

  // Arena allocations must not consume owned blocks that predate the arena.
  freeListHead.value = 0;
  return {
    get mark(): number {
      return state.mark;
    },
    get active(): boolean {
      return state.active;
    },
    reset(): void {
      resetArena(instance, state);
    },
  };
}

export function markFunctionalWasmScratch(instance: WebAssembly.Instance): number {
  const arena = beginFunctionalWasmArena(instance);
  let byMark = scratchArenas.get(instance);
  if (byMark === undefined) {
    byMark = new Map();
    scratchArenas.set(instance, byMark);
  }
  const arenas = byMark.get(arena.mark) ?? [];
  if (!byMark.has(arena.mark)) byMark.set(arena.mark, arenas);
  arenas.push(arena);
  return arena.mark;
}

export function resetFunctionalWasmScratch(
  instance: WebAssembly.Instance,
  mark: number,
): void {
  if (!Number.isSafeInteger(mark) || mark < 0 || mark > 0xffffffff) {
    throw new RangeError(`functional WASM scratch mark must be a u32; received ${mark}`);
  }
  const byMark = scratchArenas.get(instance);
  const arenas = byMark?.get(mark);
  const arena = arenas?.at(-1);
  if (byMark === undefined || arenas === undefined || arena === undefined || !arena.active) {
    throw new RangeError(`functional WASM scratch mark is not active for this instance: ${mark}`);
  }
  arena.reset();
  arenas.pop();
  if (arenas.length === 0) byMark.delete(mark);
}

function resetArena(
  instance: WebAssembly.Instance,
  state: FunctionalWasmArenaState,
): void {
  if (!state.active) {
    throw new Error(`functional WASM arena at heap mark ${state.mark} was already reset`);
  }
  const stack = arenaStacks.get(instance);
  const active = stack?.at(-1);
  if (stack === undefined || active !== state) {
    throw new Error(
      `functional WASM arena at heap mark ${state.mark} cannot reset before its nested arena at ${
        active?.mark ?? "an unknown mark"
      }`,
    );
  }

  const { heapTop, freeListHead } = allocatorGlobals(instance);
  const currentHeapTop = Number(heapTop.value) >>> 0;
  if (state.mark > currentHeapTop) {
    throw new RangeError(
      `functional WASM arena mark ${state.mark} exceeds heap top ${currentHeapTop}`,
    );
  }
  heapTop.value = state.mark;
  freeListHead.value = state.savedFreeListHead;
  discardEncodedFunctionalWasmValuesFrom(instance, state.mark);
  stack.pop();
  state.active = false;
}

function allocatorGlobals(instance: WebAssembly.Instance): {
  readonly heapTop: WebAssembly.Global;
  readonly freeListHead: WebAssembly.Global;
} {
  const heapTop = instance.exports.heapTop;
  const freeListHead = instance.exports.freeListHead;
  if (!(heapTop instanceof WebAssembly.Global) || !(freeListHead instanceof WebAssembly.Global)) {
    throw new Error("functional WASM module omitted heapTop or freeListHead exports");
  }
  return { heapTop, freeListHead };
}
