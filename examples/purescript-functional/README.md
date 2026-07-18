# PureScript type-system stress profile

[`type_profile.purs`](type_profile.purs) records the source concepts exercised by the adjacent
neutral lowering. A bounded Baba-generated PureScript parser reads that source and verifies that the
required declarations are present before constructing the backend workload. This remains a
type-system profile, not a complete PureScript frontend.

The profile checks four backend facilities that matter to a future PureScript frontend:

- an open record row is unified with a concrete record and produces a reusable tail substitution;
- a `Convert Int String` functional dependency selects a compile-time associated result;
- `Functor (Compose Array Maybe)` recursively discovers both required dictionaries;
- a rank-2 identity argument is typechecked on the GPU and its generated Wasm returns `42`.

Run it with:

```sh
deno task run:purescript-type-profile
```

Kind inference, instance-chain ordering, orphan rules, newtype coercions, foreign imports, and a
full PureScript concrete-syntax frontend are not claimed here. The example isolates whether
gpufuck's target-neutral type facilities can represent the difficult parts before such a frontend is
built.

The profile uses explicit braces and semicolons so its deliberately small grammar does not need to
implement PureScript's layout algorithm. Regenerate it with `deno task generate:purescript`.
