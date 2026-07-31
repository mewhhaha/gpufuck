/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import { BlotCompilerSession } from "./blot/src/backend/compile.ts";
import { hostInit } from "./blot/src/backend/host.ts";
import { BlotError } from "./blot/src/diagnostic.ts";
import { configureSourceLexerRecords, configureSources, LoadError } from "./blot/src/load.ts";
import { dispose as disposeBlotParser, initializeBlotParser } from "./blot/src/syntax/parse.ts";
import { resetBlotSyntaxSession, validateBlotSyntax } from "./blot/gpu_frontend.ts";
import { renderHighlight } from "./highlight.ts";
import { readWasmOutline, type WasmOutline } from "./wasm_outline.ts";

interface Example {
  readonly name: string;
  readonly path: string;
  readonly source: string;
  readonly project?: {
    readonly modules: number;
    readonly definitions: number;
    readonly lines: number;
    readonly bytes: number;
  };
}

interface PlaygroundSources {
  readonly examples: readonly Example[];
  readonly sources: Readonly<Record<string, string>>;
}

type Stage =
  | "syntax"
  | "blot-load"
  | "blot-check"
  | "blot-stage"
  | "blot-lower"
  | "surface"
  | "gpu-device"
  | "gpu-compiler"
  | "gpu-evaluator"
  | "core"
  | "gpu-run"
  | "wasm-run"
  | "wasm-emit"
  | "total";

const STAGE_LABELS: Readonly<Record<Stage, string>> = {
  syntax: "Optional Baba GPU syntax validation",
  "blot-load": "Blot cursor parse and dependency load",
  "blot-check": "Blot comptime, types, effects, and ownership",
  "blot-stage": "Blot staging and export preparation",
  "blot-lower": "Lower Blot into Functional Surface",
  surface: "Encode Functional Surface",
  "gpu-device": "Request GPU device",
  "gpu-compiler": "Initialize GPU compiler",
  "gpu-evaluator": "Initialize GPU evaluator",
  core: "Resolve and infer Functional Core on GPU",
  "gpu-run": "Initialize and run GPU evaluator",
  "wasm-run": "Emit, instantiate, and run executable Wasm",
  "wasm-emit": "Emit canonical ABI Wasm",
  total: "Total end-to-end, including setup",
};

const STAGES = Object.keys(STAGE_LABELS) as readonly Stage[];

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`playground is missing #${id}`);
  return found as T;
};

const editor = element<HTMLTextAreaElement>("source");
const highlightLayer = element<HTMLPreElement>("highlight");
const outlinePanel = element<HTMLDivElement>("outline");
const runButton = element<HTMLButtonElement>("run");
const exampleList = element<HTMLDivElement>("examples");
const stageList = element<HTMLDListElement>("stages");
const resultPanel = element<HTMLDivElement>("result");
const statusLine = element<HTMLParagraphElement>("status");
const downloadLink = element<HTMLAnchorElement>("download");
const disableCache = element<HTMLInputElement>("disable-cache");
const gpuSyntax = element<HTMLInputElement>("gpu-syntax");

const parserWasmUrl = new URL("./parser.wasm", location.href);
const parserPlanUrl = new URL("./parser.plan", location.href);
const playground: PlaygroundSources = await (await fetch("./examples.json")).json();

let selected = playground.examples[0];
let artifact: Uint8Array | undefined;
let compilerSession: BlotCompilerSession | undefined;

function paintHighlight(): void {
  renderHighlight(editor.value, highlightLayer);
  highlightLayer.scrollTop = editor.scrollTop;
  highlightLayer.scrollLeft = editor.scrollLeft;
}

function setStatus(text: string, tone: "idle" | "busy" | "error" | "ok" = "idle"): void {
  statusLine.textContent = text;
  statusLine.dataset.tone = tone;
}

function renderStages(timings: ReadonlyMap<Stage, number>, reached?: Stage): void {
  stageList.replaceChildren();
  for (const stage of STAGES) {
    const term = document.createElement("dt");
    term.textContent = STAGE_LABELS[stage];
    const detail = document.createElement("dd");
    const milliseconds = timings.get(stage);
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
  diagnostics: readonly {
    readonly code: string;
    readonly message: string;
    readonly start: number;
    readonly end: number;
  }[],
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
    span.textContent = `characters ${diagnostic.start}–${diagnostic.end}`;
    item.append(code, document.createTextNode(` ${diagnostic.message} `), span);
    list.append(item);
  }
  resultPanel.append(title, list);
}

function renderFailure(error: unknown): void {
  if (error instanceof LoadError) {
    renderDiagnostics(
      "Blot rejected the program",
      error.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        start: diagnostic.span.start,
        end: diagnostic.span.end,
      })),
    );
    return;
  }
  if (error instanceof BlotError) {
    renderDiagnostics("Blot rejected the program", [{
      code: error.diagnostic.code,
      message: error.diagnostic.message,
      start: error.diagnostic.span.start,
      end: error.diagnostic.span.end,
    }]);
    return;
  }
  resultPanel.replaceChildren();
  resultPanel.dataset.state = "error";
  const title = document.createElement("h2");
  title.textContent = "Could not compile";
  const message = document.createElement("p");
  message.textContent = error instanceof Error ? error.message : String(error);
  resultPanel.append(title, message);
}

function renderValue(
  value: unknown,
  gpuValue: unknown,
  wasmBytes: number,
  runtimeExports: number,
  output: readonly string[],
  syntaxWords: string,
): void {
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
  const agrees = runtimeJson(value) === runtimeJson(gpuValue);
  meta.textContent = `${(wasmBytes / 1024).toFixed(1)} KB canonical ABI Wasm · ` +
    `${runtimeExports} runtime exports · GPU evaluator ${agrees ? "agrees" : "differs"} · ` +
    syntaxWords;
  resultPanel.append(title, pre, meta);
  if (output.length > 0) {
    const transcript = document.createElement("pre");
    transcript.className = "exports";
    transcript.textContent = `host output\n${output.join("\n")}`;
    resultPanel.append(transcript);
  }
}

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function runtimeJson(value: unknown): string {
  return JSON.stringify(value, (key, entry) => {
    if (key === "fieldCount") return undefined;
    return bigintJson(key, entry);
  });
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
    `${outline.importCount} imported functions`;
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

async function compileAndRun(): Promise<void> {
  if (selected === undefined) return;
  const pipelineStart = performance.now();
  const coldRun = disableCache.checked;
  runButton.disabled = true;
  disableCache.disabled = true;
  gpuSyntax.disabled = true;
  downloadLink.hidden = true;
  artifact = undefined;
  const timings = new Map<Stage, number>();
  let reached: Stage | undefined;
  try {
    if (coldRun) {
      compilerSession?.destroy();
      compilerSession = undefined;
      disposeBlotParser();
      await resetBlotSyntaxSession();
    }
    setStatus(
      gpuSyntax.checked ? "Loading Blot parser and GPU frontend…" : "Loading Blot parser…",
      "busy",
    );
    await initializeBlotParser(parserWasmUrl, parserPlanUrl);

    let syntax: Awaited<ReturnType<typeof validateBlotSyntax>> | undefined;
    if (gpuSyntax.checked) {
      reached = "syntax";
      setStatus("Lexing, parsing, and validating Blot syntax on WebGPU…", "busy");
      syntax = await validateBlotSyntax(editor.value, parserPlanUrl);
      timings.set("syntax", syntax.cacheHit ? 0 : syntax.timings.totalMs);
      if (!syntax.ok) {
        timings.set("total", performance.now() - pipelineStart);
        renderStages(timings, reached);
        renderDiagnostics(
          "GPU syntax validation failed",
          syntax.diagnostics.map((diagnostic) => ({
            code: diagnostic.code,
            message: diagnostic.message,
            start: diagnostic.start,
            end: diagnostic.end,
          })),
        );
        setStatus("GPU syntax validation failed", "error");
        return;
      }
    }

    reached = "blot-load";
    setStatus("Building Blot's cursor AST, then checking and compiling…", "busy");
    configureSources(
      {
        ...playground.sources,
        [selected.path]: editor.value,
      },
      { cache: coldRun ? "clear" : "reuse-unchanged" },
    );
    if (syntax?.ok) {
      configureSourceLexerRecords(selected.path, editor.value, syntax.lexerRecords);
    }
    const evaluatorOutput: string[] = [];
    const wasmOutput: string[] = [];
    const activeSession = coldRun
      ? await BlotCompilerSession.create()
      : compilerSession ??= await BlotCompilerSession.create();
    let verified: Awaited<ReturnType<BlotCompilerSession["verify"]>>;
    try {
      verified = await activeSession.verify(selected.path, {
        evaluatorInit: hostInit((line) => evaluatorOutput.push(line)),
        wasmInit: hostInit((line) => wasmOutput.push(line)),
      });
    } finally {
      if (coldRun) activeSession.destroy();
    }
    timings.set("blot-load", verified.timings.blotLoadMilliseconds);
    timings.set("blot-check", verified.timings.blotCheckMilliseconds);
    timings.set("blot-stage", verified.timings.blotStageMilliseconds);
    timings.set("blot-lower", verified.timings.blotLowerMilliseconds);
    timings.set("surface", verified.timings.surfaceEncodeMilliseconds);
    timings.set("gpu-device", verified.timings.gpuDeviceMilliseconds);
    timings.set("gpu-compiler", verified.timings.gpuCompilerMilliseconds);
    timings.set("gpu-evaluator", verified.timings.gpuEvaluatorMilliseconds);
    timings.set("core", verified.timings.coreCompileMilliseconds);
    timings.set("gpu-run", verified.timings.gpuEvaluateMilliseconds);
    timings.set("wasm-run", verified.timings.wasmExecuteMilliseconds);
    timings.set("wasm-emit", verified.timings.canonicalWasmMilliseconds);
    timings.set("total", performance.now() - pipelineStart);
    reached = undefined;

    artifact = verified.wasm;
    downloadLink.hidden = false;
    renderStages(timings);
    renderOutline(readWasmOutline(verified.wasm));
    const runtimeExports = verified.manifest.exports.filter((entry) => entry.phase === "runtime");
    renderValue(
      verified.ran,
      verified.value,
      verified.wasm.byteLength,
      runtimeExports.length,
      wasmOutput,
      syntax?.ok
        ? `${syntax.tokenWords.toLocaleString()} token words, ` +
          `${syntax.nodeWords.toLocaleString()} node words, ` +
          `${syntax.edgeWords.toLocaleString()} edge words`
        : "Blot CPU syntax path",
    );
    if (selected.project !== undefined && editor.value === selected.source) {
      const project = selected.project;
      const projectSummary = document.createElement("p");
      projectSummary.className = "meta";
      projectSummary.textContent = `${project.modules.toLocaleString()} project modules · ` +
        `${project.definitions.toLocaleString()} reachable functions · ` +
        `${project.lines.toLocaleString()} lines · ` +
        `${(project.bytes / 1024).toFixed(1)} KB source`;
      resultPanel.append(projectSummary);
    }
    const evaluatorAgrees = JSON.stringify(evaluatorOutput) === JSON.stringify(wasmOutput);
    setStatus(
      `${coldRun ? "Cold run" : "Resident run"} compiled with ${
        syntax?.adapter ?? "Blot CPU syntax and gpufuck WebGPU Core"
      }; ` +
        `GPU and Wasm host output ${evaluatorAgrees ? "agree" : "differ"}.`,
      evaluatorAgrees ? "ok" : "error",
    );
  } catch (error) {
    timings.set("total", performance.now() - pipelineStart);
    renderStages(timings, reached);
    renderFailure(error);
    setStatus("Stopped", "error");
  } finally {
    runButton.disabled = false;
    disableCache.disabled = false;
    gpuSyntax.disabled = false;
  }
}

downloadLink.addEventListener("click", (event) => {
  if (artifact === undefined || selected === undefined) return;
  event.preventDefault();
  const url = URL.createObjectURL(
    new Blob([artifact as Uint8Array<ArrayBuffer>], { type: "application/wasm" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = selected.path.slice(selected.path.lastIndexOf("/") + 1).replace(
    /\.blot$/,
    ".wasm",
  );
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

globalThis.addEventListener("beforeunload", () => {
  compilerSession?.destroy();
  compilerSession = undefined;
  disposeBlotParser();
  void resetBlotSyntaxSession();
});

for (const [index, example] of playground.examples.entries()) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = example.name;
  button.addEventListener("click", () => {
    selected = example;
    editor.value = example.source;
    paintHighlight();
    for (const other of exampleList.children) other.removeAttribute("aria-current");
    button.setAttribute("aria-current", "true");
  });
  if (index === 0) {
    selected = example;
    editor.value = example.source;
    button.setAttribute("aria-current", "true");
  }
  exampleList.append(button);
}

paintHighlight();
renderStages(new Map());
clearOutline("Run a Blot module to see its canonical ABI sections, signatures, and exports.");
if (navigator.gpu === undefined) {
  runButton.disabled = true;
  setStatus(
    "This browser exposes no WebGPU, which the Core compiler and optional Baba GPU syntax path require.",
    "error",
  );
} else {
  setStatus("Ready. Press Run, or Ctrl/Cmd+Enter.", "idle");
}
