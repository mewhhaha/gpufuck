export interface EffectSet extends ReadonlySet<string> {
  union(other: ReadonlySetLike<string>): EffectSet;
  union<U>(other: ReadonlySetLike<U>): Set<string | U>;
  intersection(other: ReadonlySetLike<string>): EffectSet;
  intersection<U>(other: ReadonlySetLike<U>): Set<string & U>;
  difference(other: ReadonlySetLike<unknown>): EffectSet;
  difference<U>(other: ReadonlySetLike<U>): Set<string>;
  symmetricDifference(other: ReadonlySetLike<string>): EffectSet;
  symmetricDifference<U>(other: ReadonlySetLike<U>): Set<string | U>;
}

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
    union: {
      value: <U>(other: ReadonlySetLike<U>): EffectSet =>
        effectSetFrom(Set.prototype.union.call(immutable, other)),
    },
    intersection: {
      value: <U>(other: ReadonlySetLike<U>): EffectSet =>
        effectSetFrom(Set.prototype.intersection.call(immutable, other)),
    },
    difference: {
      value: (other: ReadonlySetLike<unknown>): EffectSet =>
        effectSetFrom(Set.prototype.difference.call(immutable, other)),
    },
    symmetricDifference: {
      value: <U>(other: ReadonlySetLike<U>): EffectSet =>
        effectSetFrom(Set.prototype.symmetricDifference.call(immutable, other)),
    },
  });
  Object.freeze(immutable);
  return new Proxy(immutable, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (Object.prototype.hasOwnProperty.call(target, property)) return value;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as EffectSet;
}

export function effectNames(effects: EffectSet): readonly string[] {
  return Object.freeze([...effects].sort());
}
