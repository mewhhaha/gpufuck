import { deepStrictEqual, throws } from "node:assert/strict";

import {
  buildSurfaceModule,
  decodeTransferredModule,
  effectSet,
  encodeModuleForTransfer,
  surface,
} from "../functional.ts";

Deno.test("worker transfer preserves source and host effect sets", () => {
  const module = buildSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: { kind: "integer" },
      effects: effectSet("Clock.Tick"),
      body: surface.integer(42),
    }],
    [],
    "main",
    0,
    {
      hostCapabilities: [{
        name: "Console",
        fields: [{
          kind: "operation",
          name: "write",
          effects: effectSet("Console.Write"),
          parameter: { kind: "integer" },
          result: { kind: "integer" },
        }],
      }],
    },
  );

  const transferred = structuredClone(encodeModuleForTransfer(module));
  const decoded = decodeTransferredModule(transferred);

  deepStrictEqual([...decoded.declaredDefinitionEffects[0]!], ["Clock.Tick"]);
  const consoleWrite = decoded.hostCapabilities?.[0]?.fields[0];
  if (consoleWrite?.kind !== "operation") {
    throw new Error("transferred Console.write operation is missing");
  }
  deepStrictEqual([...consoleWrite.effects], ["Console.Write"]);
  throws(
    () => (consoleWrite.effects as Set<string>).add("Network"),
    /functional effect sets are immutable/,
  );
});
