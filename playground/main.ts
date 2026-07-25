/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import type { FunctionalDiagnostic } from "../src/functional/abi.ts";
import { GpuFunctionalCompiler } from "../src/functional/compiler.ts";
import { runFunctionalWasmModule } from "../src/functional/wasm_execution.ts";
import { describeFunctionalType } from "../src/functional/wasm_value_codec.ts";
import type { LazuliDiagnostic } from "../src/semantic/abi.ts";
import { initializeLazuliParser, parseLazuliSourceForCompilation } from "../src/lazuli/frontend.ts";
import { lazuliSurfaceToFunctionalModule } from "../src/lazuli/functional_adapter.ts";

interface Example {
  readonly name: string;
  readonly source: string;
}

type Stage = "parse" | "infer" | "emit";

const STAGE_LABELS: Readonly<Record<Stage, string>> = {
  parse: "Parse",
  infer: "Resolve and infer on GPU",
  // Emission and execution share one call, so timing them separately would mean inventing a split.
  emit: "Emit and run WebAssembly",
};

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`playground is missing #${id}`);
  return found as T;
};

const editor = element<HTMLTextAreaElement>("source");
const runButton = element<HTMLButtonElement>("run");
const exampleList = element<HTMLDivElement>("examples");
const stageList = element<HTMLDListElement>("stages");
const resultPanel = element<HTMLDivElement>("result");
const statusLine = element<HTMLParagraphElement>("status");
const downloadLink = element<HTMLAnchorElement>("download");

let runtime: { compiler: GpuFunctionalCompiler; adapter: string } | undefined;
let probed: { adapter: GPUAdapter; name: string } | { reason: string } | undefined;
let artifact: Uint8Array<ArrayBuffer> | undefined;

function setStatus(text: string, tone: "idle" | "busy" | "error" | "ok" = "idle"): void {
  statusLine.textContent = text;
  statusLine.dataset.tone = tone;
}

function renderStages(timings: ReadonlyMap<Stage, number>, reached: Stage | undefined): void {
  stageList.replaceChildren();
  for (const stage of ["parse", "infer", "emit"] as const) {
    const milliseconds = timings.get(stage);
    const term = document.createElement("dt");
    term.textContent = STAGE_LABELS[stage];
    const detail = document.createElement("dd");
    if (milliseconds !== undefined) {
      detail.textContent = `${milliseconds.toFixed(1)} ms`;
    } else {
      detail.textContent = reached === stage ? "failed" : "—";
      detail.dataset.state = reached === stage ? "failed" : "skipped";
    }
    stageList.append(term, detail);
  }
}

function renderDiagnostics(
  heading: string,
  diagnostics: readonly (LazuliDiagnostic | FunctionalDiagnostic)[],
): void {
  resultPanel.replaceChildren();
  resultPanel.dataset.state = "error";
  const title = document.createElement("h2");
  title.textContent = heading;
  const list = document.createElement("ul");
  for (const diagnostic of diagnostics) {
    const item = document.createElement("li");
    const code = document.createElement("code");
    code.textContent = diagnostic.code;
    const span = document.createElement("span");
    span.className = "span";
    span.textContent = `bytes ${diagnostic.span.startByte}–${diagnostic.span.endByte}`;
    item.append(code, document.createTextNode(` ${diagnostic.message} `), span);
    list.append(item);
  }
  resultPanel.append(title, list);
}

function renderValue(value: unknown, type: string, wasmBytes: number, stats: string): void {
  resultPanel.replaceChildren();
  resultPanel.dataset.state = "ok";
  const title = document.createElement("h2");
  title.textContent = "Result";
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(
    value,
    (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry,
    2,
  );
  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = `${type} · ${(wasmBytes / 1024).toFixed(1)} KB WebAssembly · ${stats}`;
  resultPanel.append(title, pre, meta);
}

async function probeAdapter(): Promise<{ adapter: GPUAdapter; name: string } | { reason: string }> {
  if (probed !== undefined) return probed;
  if (navigator.gpu === undefined) {
    probed = {
      reason: "This browser exposes no WebGPU. Names are resolved and types inferred on the GPU, " +
        "so there is no fallback path.",
    };
    return probed;
  }
  let adapter: GPUAdapter | null = null;
  try {
    adapter = await navigator.gpu.requestAdapter();
  } catch (error) {
    probed = { reason: `WebGPU adapter discovery failed: ${(error as Error).message}` };
    return probed;
  }
  if (adapter === null) {
    probed = {
      reason: "WebGPU is present but no adapter was granted. A software adapter works, " +
        "though slowly.",
    };
    return probed;
  }
  const info = adapter.info;
  probed = {
    adapter,
    name: [info?.vendor, info?.architecture].filter(Boolean).join(" ") || "unnamed adapter",
  };
  return probed;
}

async function ensureRuntime(): Promise<{ compiler: GpuFunctionalCompiler; adapter: string }> {
  if (runtime !== undefined) return runtime;
  const capability = await probeAdapter();
  if ("reason" in capability) throw new Error(capability.reason);
  const { adapter, name } = capability;
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBuffersPerShaderStage: Math.min(
        16,
        adapter.limits.maxStorageBuffersPerShaderStage,
      ),
    },
  });
  runtime = { compiler: await GpuFunctionalCompiler.create(device), adapter: name };
  return runtime;
}

async function compileAndRun(): Promise<void> {
  runButton.disabled = true;
  downloadLink.hidden = true;
  artifact = undefined;
  const timings = new Map<Stage, number>();
  let reached: Stage | undefined;
  try {
    setStatus("Loading parser…", "busy");
    await initializeLazuliParser(
      new URL("./parser.wasm", location.href),
      new URL("./parser.plan", location.href),
    );

    reached = "parse";
    const parseStart = performance.now();
    const parsed = parseLazuliSourceForCompilation(editor.value);
    if (!parsed.frontend.ok) {
      renderStages(timings, reached);
      renderDiagnostics("Parse failed", parsed.frontend.diagnostics);
      setStatus("Parse failed", "error");
      return;
    }
    timings.set("parse", performance.now() - parseStart);

    setStatus("Requesting a WebGPU adapter…", "busy");
    const { compiler, adapter } = await ensureRuntime();

    setStatus(`Resolving and inferring on ${adapter}…`, "busy");
    reached = "infer";
    const inferStart = performance.now();
    const compilation = await compiler.compileModule(
      lazuliSurfaceToFunctionalModule(parsed.frontend.surface, parsed.sourceByteLength),
    );
    if (!compilation.ok) {
      renderStages(timings, reached);
      renderDiagnostics("Typecheck failed", compilation.diagnostics);
      setStatus("Typecheck failed", "error");
      return;
    }
    timings.set("infer", performance.now() - inferStart);

    try {
      setStatus("Emitting WebAssembly…", "busy");
      reached = "emit";
      const emitStart = performance.now();
      const execution = await runFunctionalWasmModule(compilation.module);
      timings.set("emit", performance.now() - emitStart);
      reached = undefined;

      artifact = execution.bytes;
      downloadLink.hidden = false;
      renderStages(timings, reached);
      renderValue(
        execution.value,
        describeFunctionalType(compilation.module.entryType),
        execution.bytes.byteLength,
        `${execution.stats.thunkEvaluations} thunk evaluations`,
      );
      setStatus(`Compiled and ran on ${adapter}`, "ok");
    } finally {
      compilation.module.destroy();
    }
  } catch (error) {
    renderStages(timings, reached);
    resultPanel.replaceChildren();
    resultPanel.dataset.state = "error";
    const title = document.createElement("h2");
    title.textContent = "Could not compile";
    const message = document.createElement("p");
    message.textContent = error instanceof Error ? error.message : String(error);
    resultPanel.append(title, message);
    setStatus("Stopped", "error");
  } finally {
    runButton.disabled = false;
  }
}

downloadLink.addEventListener("click", (event) => {
  if (artifact === undefined) return;
  event.preventDefault();
  const url = URL.createObjectURL(new Blob([artifact], { type: "application/wasm" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "module.wasm";
  anchor.click();
  URL.revokeObjectURL(url);
});

runButton.addEventListener("click", () => void compileAndRun());
editor.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void compileAndRun();
  }
});

const examples: readonly Example[] = await (await fetch("./examples.json")).json();
for (const [index, example] of examples.entries()) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = example.name;
  button.addEventListener("click", () => {
    editor.value = example.source;
    for (const other of exampleList.children) other.removeAttribute("aria-current");
    button.setAttribute("aria-current", "true");
  });
  if (index === 0) {
    editor.value = example.source;
    button.setAttribute("aria-current", "true");
  }
  exampleList.append(button);
}

renderStages(new Map(), undefined);
setStatus("Checking for a WebGPU adapter…", "busy");
const capability = await probeAdapter();
if ("reason" in capability) {
  runButton.disabled = true;
  setStatus(capability.reason, "error");
} else {
  setStatus(`Ready on ${capability.name}. Press Run, or Ctrl/Cmd+Enter.`, "idle");
}
