/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import type { Diagnostic } from "../src/functional/abi.ts";
import { GpuCompiler } from "../src/functional/compiler.ts";
import { runWasmModule } from "../src/functional/wasm_execution.ts";
import { describeType } from "../src/functional/wasm_value_codec.ts";
import type { SemanticDiagnostic } from "../src/semantic/abi.ts";
import type { GleamDiagnostic } from "../src/gleam/diagnostic.ts";
import { lowerGleamSource } from "../src/gleam/frontend.ts";
import { initializeGleamParser } from "../src/gleam/parser.ts";
import { renderHighlight } from "./highlight.ts";
import { readWasmOutline, type WasmOutline } from "./wasm_outline.ts";

interface Example {
  readonly name: string;
  readonly source: string;
}

type Stage = "parse" | "infer" | "emit";

const STAGE_LABELS: Readonly<Record<Stage, string>> = {
  // Gleam parses and lowers in one call, so splitting these two would mean inventing a boundary.
  parse: "Parse and lower",
  infer: "Resolve and infer on GPU",
  // Emission and execution share one call, so timing them separately would mean inventing a split.
  emit: "Emit and run WebAssembly",
};

/** The module name the entry point is compiled under; Gleam needs one and the tab has no path. */
const MODULE_NAME = "playground";

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`playground is missing #${id}`);
  return found as T;
};

const editor = element<HTMLTextAreaElement>("source");
const highlightLayer = element<HTMLPreElement>("highlight");
const batchSelect = element<HTMLSelectElement>("batch");
const outlinePanel = element<HTMLDivElement>("outline");
const runButton = element<HTMLButtonElement>("run");
const exampleList = element<HTMLDivElement>("examples");
const stageList = element<HTMLDListElement>("stages");
const resultPanel = element<HTMLDivElement>("result");
const statusLine = element<HTMLParagraphElement>("status");
const downloadLink = element<HTMLAnchorElement>("download");

let runtime: { compiler: GpuCompiler; adapter: string } | undefined;
let probed: { adapter: GPUAdapter; name: string } | { reason: string } | undefined;
let artifact: Uint8Array<ArrayBuffer> | undefined;

/**
 * Repaints the highlight layer and keeps it aligned with the textarea above it.
 *
 * The textarea stays the thing that receives input — it keeps native caret, selection, undo, IME and
 * accessibility, all of which a contenteditable reimplementation would have to earn back. The layer
 * behind it only has to agree about metrics and scroll offset.
 */
function paintHighlight(): void {
  renderHighlight(editor.value, highlightLayer);
  highlightLayer.scrollTop = editor.scrollTop;
  highlightLayer.scrollLeft = editor.scrollLeft;
}

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
  diagnostics: readonly (SemanticDiagnostic | Diagnostic | GleamDiagnostic)[],
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

function clearOutline(note: string): void {
  outlinePanel.replaceChildren();
  const empty = document.createElement("p");
  empty.className = "meta";
  empty.textContent = note;
  outlinePanel.append(empty);
}

function renderOutline(outline: WasmOutline | undefined): void {
  outlinePanel.replaceChildren();
  if (outline === undefined) {
    clearOutline("The module was emitted but could not be read back structurally.");
    return;
  }
  const summary = document.createElement("p");
  summary.className = "meta";
  summary.textContent = `${(outline.byteLength / 1024).toFixed(1)} KB · ` +
    `${outline.functionCount} functions · ${outline.typeCount} signatures · ` +
    `${outline.importCount} imported functions` +
    (outline.memoryPages === undefined ? "" : ` · ${outline.memoryPages} memory pages`);
  outlinePanel.append(summary);

  const table = document.createElement("table");
  table.className = "sections";
  const head = document.createElement("tr");
  for (const label of ["Section", "Bytes", "Share"]) {
    const cell = document.createElement("th");
    cell.textContent = label;
    head.append(cell);
  }
  table.append(head);
  for (const section of outline.sections) {
    const row = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = section.name;
    const bytes = document.createElement("td");
    bytes.className = "numeric";
    bytes.textContent = section.byteLength.toLocaleString();
    const share = document.createElement("td");
    share.className = "numeric";
    share.textContent = `${((section.byteLength / outline.byteLength) * 100).toFixed(1)}%`;
    row.append(name, bytes, share);
    table.append(row);
  }
  outlinePanel.append(table);

  if (outline.exports.length > 0) {
    const exports = document.createElement("pre");
    exports.className = "exports";
    exports.textContent = outline.exports
      .map((entry) =>
        `(export "${entry.name}" (${entry.kind}${
          entry.signature === undefined ? "" : ` ${entry.signature}`
        }))`
      )
      .join("\n");
    outlinePanel.append(exports);
  }
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

async function ensureRuntime(): Promise<{ compiler: GpuCompiler; adapter: string }> {
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
  runtime = { compiler: await GpuCompiler.create(device), adapter: name };
  return runtime;
}

/**
 * Compiles the same source as `count` independent modules and reports marginal cost per module.
 *
 * This is the shape the GPU actually wins at, and the reason the page offers it: a single small
 * module is almost entirely one readback, so it measures the floor rather than the compiler. Nothing
 * is executed here — the point is compile throughput, and running a thousand modules would measure
 * the interpreter instead.
 */
async function compileBatch(count: number): Promise<void> {
  const timings = new Map<Stage, number>();
  setStatus("Loading parser…", "busy");
  await initializeGleamParser(
    new URL("./parser.wasm", location.href),
    new URL("./parser.plan", location.href),
  );

  // Parsing is synchronous and single-threaded here — the browser cannot use
  // `ParallelGleamFrontend`, which needs workers — so a large example at a high batch count is
  // seconds of blocked main thread. Yielding every few modules keeps the page responsive and lets
  // the count update, which turns an apparent hang into visible progress.
  const sourceBytes = new TextEncoder().encode(editor.value).byteLength * count;
  setStatus(
    `Parsing ${count.toLocaleString()} x ${(sourceBytes / count / 1024).toFixed(1)} KB = ` +
      `${(sourceBytes / 1024 / 1024).toFixed(2)} MB of Gleam on one thread...`,
    "busy",
  );
  const parseStart = performance.now();
  const modules = [];
  for (let index = 0; index < count; index++) {
    const parsed = lowerGleamSource(`${MODULE_NAME}_${index}`, editor.value);
    if (!parsed.ok) {
      renderStages(timings, "parse");
      renderDiagnostics("Parse failed", parsed.diagnostics);
      setStatus("Parse failed", "error");
      return;
    }
    modules.push(parsed.lowered.module);
    if ((index & 7) === 7 && index + 1 < count) {
      setStatus(
        `Parsed ${(index + 1).toLocaleString()} of ${count.toLocaleString()} modules...`,
        "busy",
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  timings.set("parse", performance.now() - parseStart);

  setStatus("Requesting a WebGPU adapter…", "busy");
  const { compiler, adapter } = await ensureRuntime();

  setStatus(`Compiling ${count.toLocaleString()} modules on ${adapter}…`, "busy");
  const compileStart = performance.now();
  const results = await compiler.compileBatch(modules);
  const compileMilliseconds = performance.now() - compileStart;
  timings.set("infer", compileMilliseconds);

  const failed = results.filter((result) => !result.ok);
  for (const result of results) if (result.ok) result.module.destroy();
  renderStages(timings, undefined);

  if (failed.length > 0) {
    const first = failed[0];
    renderDiagnostics(
      `${failed.length} of ${count} modules failed`,
      first !== undefined && !first.ok ? first.diagnostics : [],
    );
    setStatus("Batch failed", "error");
    return;
  }

  const nodes = modules.reduce((total, module) => total + module.nodeCount, 0);
  const frontendMilliseconds = timings.get("parse") ?? 0;
  resultPanel.replaceChildren();
  resultPanel.dataset.state = "ok";
  const title = document.createElement("h2");
  title.textContent = "Batch";
  const pre = document.createElement("pre");
  pre.textContent = [
    `${count.toLocaleString()} modules, ${(sourceBytes / 1024 / 1024).toFixed(2)} MB of Gleam`,
    `${nodes.toLocaleString()} surface nodes total`,
    ``,
    `${frontendMilliseconds.toFixed(0)} ms  parse and lower  (CPU, one thread)`,
    `${compileMilliseconds.toFixed(0)} ms  resolve and infer (GPU)`,
    ``,
    `${(compileMilliseconds * 1000 / count).toFixed(1)} µs per module on the GPU`,
  ].join("\n");
  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent =
    "The frontend runs on one CPU thread here: the browser cannot use the worker pool that makes " +
    "it 4.7-6.5x faster outside it, and parsing does not touch the GPU at all. Nothing was executed.";
  resultPanel.append(title, pre, meta);
  clearOutline("Batch mode compiles but does not emit; switch to 1 module to see a binary.");
  setStatus(`Compiled ${count.toLocaleString()} modules on ${adapter}`, "ok");
}

async function compileAndRun(): Promise<void> {
  runButton.disabled = true;
  downloadLink.hidden = true;
  artifact = undefined;
  const timings = new Map<Stage, number>();
  let reached: Stage | undefined;
  try {
    const batch = Number.parseInt(batchSelect.value, 10);
    if (Number.isFinite(batch) && batch > 1) {
      await compileBatch(batch);
      return;
    }
    setStatus("Loading parser…", "busy");
    await initializeGleamParser(
      new URL("./parser.wasm", location.href),
      new URL("./parser.plan", location.href),
    );

    reached = "parse";
    const parseStart = performance.now();
    const parsed = lowerGleamSource(MODULE_NAME, editor.value);
    if (!parsed.ok) {
      renderStages(timings, reached);
      renderDiagnostics("Parse failed", parsed.diagnostics);
      setStatus("Parse failed", "error");
      return;
    }
    timings.set("parse", performance.now() - parseStart);

    setStatus("Requesting a WebGPU adapter…", "busy");
    const { compiler, adapter } = await ensureRuntime();

    setStatus(`Resolving and inferring on ${adapter}…`, "busy");
    reached = "infer";
    const inferStart = performance.now();
    const compilation = await compiler.compileModule(parsed.lowered.module);
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
      const execution = await runWasmModule(compilation.module);
      timings.set("emit", performance.now() - emitStart);
      reached = undefined;

      artifact = execution.bytes;
      downloadLink.hidden = false;
      renderOutline(readWasmOutline(execution.bytes));
      renderStages(timings, reached);
      renderValue(
        execution.value,
        describeType(compilation.module.entryType),
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
editor.addEventListener("input", paintHighlight);
editor.addEventListener("scroll", () => {
  highlightLayer.scrollTop = editor.scrollTop;
  highlightLayer.scrollLeft = editor.scrollLeft;
});
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
    paintHighlight();
    for (const other of exampleList.children) other.removeAttribute("aria-current");
    button.setAttribute("aria-current", "true");
  });
  if (index === 0) {
    editor.value = example.source;
    button.setAttribute("aria-current", "true");
  }
  exampleList.append(button);
}

paintHighlight();
renderStages(new Map(), undefined);
clearOutline("Run a module to see its sections, signatures and exports.");
setStatus("Checking for a WebGPU adapter…", "busy");
const capability = await probeAdapter();
if ("reason" in capability) {
  runButton.disabled = true;
  setStatus(capability.reason, "error");
} else {
  setStatus(`Ready on ${capability.name}. Press Run, or Ctrl/Cmd+Enter.`, "idle");
}
