export type EffectSet = ReadonlySet<string>;

export function effectSet(...effects: readonly string[]): EffectSet {
  return effectSetFrom(effects);
}

export function effectSetFrom(effects: Iterable<string>): EffectSet {
  const names = new Set<string>();
  for (const effect of effects) {
    if (typeof effect !== "string" || effect.length === 0) {
      throw new TypeError(
        `functional effect names must be nonempty strings; received ${JSON.stringify(effect)}`,
      );
    }
    names.add(effect);
  }
  const immutable = new Set([...names].sort());
  const rejectMutation = (): never => {
    throw new TypeError("functional effect sets are immutable");
  };
  Object.defineProperties(immutable, {
    add: { value: rejectMutation },
    delete: { value: rejectMutation },
    clear: { value: rejectMutation },
  });
  return Object.freeze(immutable);
}

export function effectNames(effects: EffectSet): readonly string[] {
  return Object.freeze([...effects].sort());
}
