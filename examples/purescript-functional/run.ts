import {
  GpuFunctionalCompiler,
  requestWebGpuDevice,
  runFunctionalWasmModule,
} from "../../functional.ts";
import { createPureScriptTypeProfile } from "../../purescript_type_profile.ts";

const source = await Deno.readTextFile(
  new URL("./type_profile.purs", import.meta.url),
);
const profile = createPureScriptTypeProfile(source);
const device = await requestWebGpuDevice();
try {
  const compiler = await GpuFunctionalCompiler.create(device);
  const compilation = await compiler.compileModule(profile.rank2Module);
  if (!compilation.ok) throw new Error(compilation.diagnostics[0].message);
  try {
    const execution = await runFunctionalWasmModule(compilation.module);
    console.log(JSON.stringify(
      {
        projectedRow: profile.projectedRow,
        parsedModule: profile.source.moduleName,
        rowSubstitution: profile.rowSubstitution,
        convertedType: profile.convertedType,
        functorRules: [
          profile.functorEvidence.ruleId,
          ...profile.functorEvidence.premises.map((premise) => premise.ruleId),
        ],
        transitions: profile.transitions,
        wasmValue: execution.value,
        wasmByteLength: execution.bytes.byteLength,
      },
      null,
      2,
    ));
  } finally {
    compilation.module.destroy();
  }
} finally {
  device.destroy();
}
