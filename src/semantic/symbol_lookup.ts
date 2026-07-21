import {
  type EncodedLazuliSurface,
  LAZULI_CONSTRUCTOR_WORD_LENGTH,
  LAZULI_DEFINITION_WORD_LENGTH,
  LAZULI_NO_INDEX,
  LAZULI_TYPE_WORD_LENGTH,
  LazuliConstructorWord,
  LazuliDefinitionWord,
  LazuliTypeWord,
} from "./abi.ts";

export const LAZULI_SYMBOL_LOOKUP_WORD_LENGTH = 3;

export const LazuliSymbolLookupWord = {
  Definition: 0,
  Type: 1,
  Constructor: 2,
} as const;

export function createLazuliSymbolLookup(surface: EncodedLazuliSurface): Uint32Array {
  const words = new Uint32Array(
    surface.symbolNames.length * LAZULI_SYMBOL_LOOKUP_WORD_LENGTH,
  );
  words.fill(LAZULI_NO_INDEX);
  recordFirstIndices(
    words,
    surface.definitionWords,
    LAZULI_DEFINITION_WORD_LENGTH,
    LazuliDefinitionWord.Symbol,
    LazuliSymbolLookupWord.Definition,
  );
  recordFirstIndices(
    words,
    surface.typeWords,
    LAZULI_TYPE_WORD_LENGTH,
    LazuliTypeWord.Symbol,
    LazuliSymbolLookupWord.Type,
  );
  recordFirstIndices(
    words,
    surface.constructorWords,
    LAZULI_CONSTRUCTOR_WORD_LENGTH,
    LazuliConstructorWord.Symbol,
    LazuliSymbolLookupWord.Constructor,
  );
  return words;
}

function recordFirstIndices(
  lookupWords: Uint32Array,
  records: Uint32Array,
  recordWordLength: number,
  symbolWord: number,
  lookupWord: number,
): void {
  const symbolCount = lookupWords.length / LAZULI_SYMBOL_LOOKUP_WORD_LENGTH;
  for (let recordIndex = 0; recordIndex < records.length / recordWordLength; recordIndex++) {
    const symbol = records[recordIndex * recordWordLength + symbolWord]!;
    if (symbol >= symbolCount) continue;
    const offset = symbol * LAZULI_SYMBOL_LOOKUP_WORD_LENGTH + lookupWord;
    if (lookupWords[offset] === LAZULI_NO_INDEX) lookupWords[offset] = recordIndex;
  }
}
