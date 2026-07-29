/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import type { Diagnostic } from "../src/functional/abi.ts";
import { GpuCompiler } from "../src/functional/compiler.ts";
import { decodeTransferredModule } from "../src/functional/module_transfer.ts";
import { runWasmModule } from "../src/functional/wasm_execution.ts";
import { describeType } from "../src/functional/wasm_value_codec.ts";
import type { SemanticDiagnostic } from "../src/semantic/abi.ts";
import type { GleamDiagnostic } from "../src/gleam/diagnostic.ts";
import { lowerGleamSource } from "../src/gleam/frontend.ts";
import { initializeGleamParser } from "../src/gleam/parser.ts";
import { renderHighlight } from "./highlight.ts";
import { readWasmOutline, type WasmOutline } from "./wasm_outline.ts";
import type { WorkerResponse } from "./frontend_worker.ts";
import type { EncodedModule } from "../functional.ts";

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

/**
 * A worker pool for the frontend, which is 99% of a batch compile.
 *
 * Measured 2026-07-27: of a 133 ms frontend, baba's lexer is 1.13 ms. Tree building, the Gleam AST
 * and lowering are the rest, and all of it is pure per module — so spreading modules across cores is
 * the only lever with real headroom here. A GPU lexer would cap out at 1.01x.
 *
 * Workers are created once and reused, because each instantiates its own baba parser.
 */
class FrontendPool {
  readonly #workers: Worker[] = [];

  get size(): number {
    return this.#workers.length;
  }

  #ensure(): readonly Worker[] {
    if (this.#workers.length > 0) return this.#workers;
    // One per core less one, leaving the main thread free to stay responsive and submit GPU work.
    const count = Math.max(1, (navigator.hardwareConcurrency ?? 4) - 1);
    for (let index = 0; index < count; index++) {
      this.#workers.push(
        new Worker(new URL("./frontend_worker.js", location.href), { type: "module" }),
      );
    }
    return this.#workers;
  }

  async lower(
    units: readonly { readonly name: string; readonly source: string }[],
    onProgress: (done: number) => void,
  ): Promise<readonly ({ ok: true; module: EncodedModule } | { ok: false; diagnostic: string })[]> {
    const workers = this.#ensure();
    const wasmUrl = new URL("./parser.wasm", location.href).href;
    const planUrl = new URL("./parser.plan", location.href).href;
    const results = new Array<
      { ok: true; module: EncodedModule } | { ok: false; diagnostic: string } | undefined
    >(units.length);
    // Contiguous slices: adjacent units in a batch are similar in size, so this balances without a
    // scheduler.
    const perWorker = Math.ceil(units.length / workers.length);
    let done = 0;

    await Promise.all(workers.map((worker, workerIndex) => {
      const start = workerIndex * perWorker;
      const slice = units.slice(start, start + perWorker);
      if (slice.length === 0) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<readonly WorkerResponse[]>) => {
          for (const response of event.data) {
            results[response.id] = response.module === undefined
              ? { ok: false, diagnostic: response.diagnostic ?? "lowering failed" }
              : { ok: true, module: decodeTransferredModule(response.module) };
          }
          done += slice.length;
          onProgress(done);
          resolve();
        };
        worker.onerror = (event) => reject(new Error(`frontend worker failed: ${event.message}`));
        worker.postMessage(
          slice.map((unit, offset) => ({
            id: start + offset,
            name: unit.name,
            source: unit.source,
            wasmUrl,
            planUrl,
          })),
        );
      });
    }));

    return results.map((result, index) => {
      if (result === undefined) throw new Error(`frontend pool dropped unit ${index}`);
      return result;
    });
  }
}

const frontendPool = new FrontendPool();

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

  // Spread the frontend across workers. It is 99% of a batch compile — baba's lexer is 1% of it —
  // so this is where the only real headroom is, and the main thread stays free to render progress.
  const sourceBytes = new TextEncoder().encode(editor.value).byteLength * count;
  const units = Array.from({ length: count }, (_, index) => ({
    name: `${MODULE_NAME}_${index}`,
    source: editor.value,
  }));
  setStatus(
    `Parsing ${(sourceBytes / 1024 / 1024).toFixed(2)} MB of Gleam across ${
      frontendPool.size ||
      Math.max(1, (navigator.hardwareConcurrency ?? 4) - 1)
    } workers…`,
    "busy",
  );
  const parseStart = performance.now();
  const lowered = await frontendPool.lower(units, (done) => {
    setStatus(`Parsed ${done.toLocaleString()} of ${count.toLocaleString()} modules…`, "busy");
  });
  const parseFailure = lowered.find((result) => !result.ok);
  if (parseFailure !== undefined && !parseFailure.ok) {
    renderStages(timings, "parse");
    resultPanel.replaceChildren();
    resultPanel.dataset.state = "error";
    const title = document.createElement("h2");
    title.textContent = "Parse failed";
    const message = document.createElement("p");
    message.textContent = parseFailure.diagnostic;
    resultPanel.append(title, message);
    setStatus("Parse failed", "error");
    return;
  }
  const modules = lowered.flatMap((result) => (result.ok ? [result.module] : []));
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
    `${frontendMilliseconds.toFixed(0)} ms  parse and lower  (CPU, ${frontendPool.size} workers)`,
    `${compileMilliseconds.toFixed(0)} ms  resolve and infer (GPU)`,
    ``,
    `${(compileMilliseconds * 1000 / count).toFixed(1)} µs per module on the GPU`,
  ].join("\n");
  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent =
    `Parsing and lowering run on ${frontendPool.size} CPU workers and never touch the GPU — baba's ` +
    "lexer is 1% of the frontend, so moving it to the GPU would be worth 1.01x. The GPU line above " +
    "is name resolution and Hindley-Milner inference only. Nothing was executed.";
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
