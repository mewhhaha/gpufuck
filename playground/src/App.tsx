import {
  Button,
  Label,
  Select,
  SelectOption,
  SelectPopover,
  SelectTrigger,
  SelectValue,
  Status,
  TextArea,
  TextField,
} from "@comp0/react";
import { useEffect, useRef, useState, type KeyboardEvent, type UIEvent } from "react";

import {
  type BrowserCompilationResult,
  type CompilationProgress,
  type PlaygroundDiagnostic,
} from "./compiler/browser-compiler";
import {
  describeFailure,
  formatByteLength,
  formatDuration,
  formatValue,
  sourceLocation,
  utf16IndexAtByte,
} from "./compiler/presentation";
import { loadExampleManifest, loadExampleSource, type LazuliExample } from "./examples";
import { highlightLazuliSource } from "./lazuli-highlighting";

type ExampleState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly examples: readonly LazuliExample[] }
  | { readonly kind: "failure"; readonly message: string };

type ResultState =
  | { readonly kind: "idle" }
  | { readonly kind: "working"; readonly progress: CompilationProgress }
  | { readonly kind: "infrastructure-failure"; readonly message: string }
  | { readonly kind: "complete"; readonly result: BrowserCompilationResult };

const webGpuAvailable = globalThis.isSecureContext && navigator.gpu !== undefined;
let compilerModule: Promise<typeof import("./compiler/browser-compiler")> | undefined;

export function App() {
  const [examples, setExamples] = useState<ExampleState>({ kind: "loading" });
  const [selectedExamplePath, setSelectedExamplePath] = useState("");
  const [source, setSource] = useState("");
  const [result, setResult] = useState<ResultState>({ kind: "idle" });
  const sourceEditor = useRef<HTMLTextAreaElement>(null);
  const sourceGutter = useRef<HTMLDivElement>(null);
  const sourceHighlight = useRef<HTMLPreElement>(null);
  const sourceLoadSequence = useRef(0);
  const working = result.kind === "working";

  useEffect(() => {
    let active = true;
    void loadExampleManifest()
      .then(async (loadedExamples) => {
        const initialExample =
          loadedExamples.find(({ path }) => path.endsWith("/answer.laz")) ?? loadedExamples[0];
        if (initialExample === undefined) {
          throw new Error("browser example manifest omitted its first example");
        }
        const initialSource = await loadExampleSource(initialExample);
        if (!active) return;
        setExamples({ kind: "ready", examples: loadedExamples });
        setSelectedExamplePath(initialExample.path);
        setSource(initialSource);
      })
      .catch((cause: unknown) => {
        if (active) setExamples({ kind: "failure", message: describeFailure(cause) });
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(
    () => () => {
      void compilerModule?.then(({ disposeBrowserCompiler }) => disposeBrowserCompiler());
    },
    [],
  );

  async function selectExample(path: string) {
    if (examples.kind !== "ready") return;
    const example = examples.examples.find((candidate) => candidate.path === path);
    if (example === undefined) {
      setResult({
        kind: "infrastructure-failure",
        message: `example selection referenced unknown path ${JSON.stringify(path)}`,
      });
      return;
    }

    const sequence = sourceLoadSequence.current + 1;
    sourceLoadSequence.current = sequence;
    setSelectedExamplePath(path);
    try {
      const nextSource = await loadExampleSource(example);
      if (sourceLoadSequence.current !== sequence) return;
      setSource(nextSource);
      setResult({ kind: "idle" });
      sourceEditor.current?.focus();
    } catch (cause) {
      if (sourceLoadSequence.current !== sequence) return;
      setResult({ kind: "infrastructure-failure", message: describeFailure(cause) });
    }
  }

  async function compileAndRun() {
    if (working || !webGpuAvailable || source.length === 0) return;
    setResult({ kind: "working", progress: "Loading parser" });
    try {
      compilerModule ??= import("./compiler/browser-compiler");
      const { compileBrowserSource } = await compilerModule;
      const compilation = await compileBrowserSource(source, (progress) => {
        setResult({ kind: "working", progress });
      });
      setResult({ kind: "complete", result: compilation });
    } catch (cause) {
      setResult({ kind: "infrastructure-failure", message: describeFailure(cause) });
    }
  }

  function handleEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    void compileAndRun();
  }

  function synchronizeEditorScroll(event: UIEvent<HTMLTextAreaElement>) {
    if (sourceGutter.current !== null) {
      sourceGutter.current.scrollTop = event.currentTarget.scrollTop;
    }
    if (sourceHighlight.current !== null) {
      sourceHighlight.current.scrollTop = event.currentTarget.scrollTop;
      sourceHighlight.current.scrollLeft = event.currentTarget.scrollLeft;
    }
  }

  function selectDiagnostic(diagnostic: PlaygroundDiagnostic) {
    const editor = sourceEditor.current;
    if (editor === null) return;
    editor.focus();
    editor.setSelectionRange(
      utf16IndexAtByte(source, diagnostic.span.startByte),
      utf16IndexAtByte(source, diagnostic.span.endByte),
    );
  }

  function downloadWasm() {
    if (result.kind !== "complete" || result.result.kind !== "success") return;
    const blob = new Blob([result.result.wasm], { type: "application/wasm" });
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    const sourceName =
      selectedExamplePath
        .split("/")
        .at(-1)
        ?.replace(/\.laz$/, "") ?? "program";
    link.download = `${sourceName}.wasm`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 0);
  }

  const compilation = result.kind === "complete" ? result.result : undefined;
  const success = compilation?.kind === "success" ? compilation : undefined;
  const timings = compilation?.timings;
  const diagnostics = compilation?.kind === "diagnostics" ? compilation.diagnostics : [];
  const lineNumbers = Array.from(
    { length: source.split("\n").length },
    (_, index) => index + 1,
  ).join("\n");
  const status = statusPresentation(result, webGpuAvailable);
  const examplesReady = examples.kind === "ready";

  return (
    <>
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />

      <header className="site-header">
        <a
          className="wordmark"
          href="https://github.com/mewhhaha/gpufuck"
          aria-label="gpufuck on GitHub"
        >
          <span className="wordmark-mark" aria-hidden="true">
            g
          </span>
          <span>gpufuck</span>
        </a>
        <a className="repository-link" href="https://github.com/mewhhaha/gpufuck">
          Source on GitHub <span aria-hidden="true">↗</span>
        </a>
      </header>

      <main>
        <section className="hero" aria-labelledby="page-title">
          <div className="eyebrow">
            <span className="live-dot" /> Runs entirely in this tab
          </div>
          <h1 id="page-title">
            Your GPU is
            <br />
            <em>the compiler.</em>
          </h1>
          <p className="hero-copy">
            Edit a lazy functional program. WebGPU resolves and infers it. Then gpufuck emits
            ordinary WebAssembly and runs the result—without a server round trip.
          </p>
          <div className="capability-row">
            <span className={`capability-badge ${webGpuAvailable ? "available" : "unavailable"}`}>
              {webGpuAvailable
                ? "WebGPU API available"
                : globalThis.isSecureContext
                  ? "WebGPU unavailable"
                  : "HTTPS required"}
            </span>
            <span className="capability-note">A current WebGPU browser is required</span>
          </div>
        </section>

        <section className="playground" aria-label="Compiler playground">
          <div className="editor-panel">
            <div className="panel-heading">
              <div>
                <span className="panel-kicker">01 / Source</span>
                <h2>Lazuli</h2>
              </div>
              <Select
                as="div"
                className="example-picker"
                value={selectedExamplePath}
                onChange={(path) => void selectExample(path)}
                disabled={!examplesReady || working}
              >
                <Label>Example</Label>
                <SelectTrigger className="example-trigger">
                  <SelectValue placeholder={examples.kind === "loading" ? "Loading…" : "Choose"} />
                  <span aria-hidden="true">⌄</span>
                </SelectTrigger>
                <SelectPopover className="example-popover" placement="bottom end" offset={6}>
                  {examples.kind === "ready" &&
                    examples.examples.map((example) => (
                      <SelectOption
                        className="example-option"
                        value={example.path}
                        key={example.path}
                      >
                        {example.name}
                      </SelectOption>
                    ))}
                </SelectPopover>
              </Select>
            </div>

            <TextField
              as="div"
              className="editor-shell"
              value={source}
              onChange={setSource}
              disabled={!examplesReady || working}
            >
              <Label className="visually-hidden">Lazuli source code</Label>
              <div ref={sourceGutter} className="editor-gutter" aria-hidden="true">
                {lineNumbers}
              </div>
              <div className="editor-code">
                <pre ref={sourceHighlight} className="source-highlight" aria-hidden="true">
                  {highlightLazuliSource(source).map((token) =>
                    token.kind === "plain" ? (
                      token.value
                    ) : (
                      <span className={`syntax-${token.kind}`} key={token.start}>
                        {token.value}
                      </span>
                    ),
                  )}
                  {"\n"}
                </pre>
                <TextArea
                  ref={sourceEditor}
                  aria-label="Lazuli source code"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  onKeyDown={handleEditorKeyDown}
                  onScroll={synchronizeEditorScroll}
                />
              </div>
            </TextField>

            <div className="editor-actions">
              <span className="keyboard-hint">
                <kbd>⌘</kbd>
                <span>+</span>
                <kbd>Enter</kbd>
              </span>
              <Button
                className="compile-button"
                pending={working}
                disabled={!webGpuAvailable || !examplesReady || source.length === 0}
                onClick={() => void compileAndRun()}
              >
                <span>{working ? "Compiling…" : "Compile & run"}</span>
                <svg
                  className="button-arrow"
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M17.25 8.25 21 12m0 0-3.75 3.75M21 12H3"
                  />
                </svg>
              </Button>
            </div>
          </div>

          <div className="result-panel">
            <div className="panel-heading result-heading">
              <div>
                <span className="panel-kicker">02 / Pipeline</span>
                <h2>Live result</h2>
              </div>
              <Status className={`run-status ${status.tone}`}>{status.label}</Status>
            </div>

            <div className="pipeline" aria-label="Compilation stages">
              <PipelineStage
                index="1"
                name="Parse"
                time={formatDuration(timings?.parseMilliseconds)}
                runtime="CPU · Baba"
              />
              <div className="pipeline-connector" aria-hidden="true" />
              <PipelineStage
                index="2"
                name="Resolve + infer"
                time={formatDuration(timings?.gpuMilliseconds)}
                runtime="GPU · WebGPU"
                featured
              />
              <div className="pipeline-connector" aria-hidden="true" />
              <PipelineStage
                index="3"
                name="Emit + execute"
                time={formatDuration(timings?.wasmMilliseconds)}
                runtime="CPU · Wasm"
              />
            </div>

            <div className="output-card">
              <span className="output-label">main returned</span>
              <output className="result-value">
                {success === undefined ? "—" : formatValue(success.value)}
              </output>
              <span className="result-type">
                {success?.type ??
                  (working ? result.progress : "Compile a program to inspect its type")}
              </span>
            </div>

            <dl className="metrics">
              <Metric label="Core nodes" value={success?.nodeCount.toLocaleString() ?? "—"} />
              <Metric label="Wasm size" value={formatByteLength(success?.wasm.byteLength)} />
              <Metric label="Allocated" value={formatByteLength(success?.allocatedBytes)} />
              <Metric
                label="Thunks forced"
                value={success?.thunkEvaluations.toLocaleString() ?? "—"}
              />
            </dl>

            <div className="diagnostics-section">
              <div className="diagnostics-heading">
                <span>Diagnostics</span>
                <Button
                  className="download-button"
                  disabled={success === undefined}
                  onClick={downloadWasm}
                >
                  Download .wasm
                </Button>
              </div>
              <div className="diagnostics" aria-live="polite">
                {result.kind === "infrastructure-failure" && (
                  <p className="empty-diagnostics failure-message">{result.message}</p>
                )}
                {examples.kind === "failure" && (
                  <p className="empty-diagnostics failure-message">{examples.message}</p>
                )}
                {diagnostics.map((diagnostic) => (
                  <Button
                    className="diagnostic"
                    key={`${diagnostic.code}:${diagnostic.span.startByte}:${diagnostic.message}`}
                    title="Select this source range"
                    onClick={() => selectDiagnostic(diagnostic)}
                  >
                    <span className="diagnostic-code">
                      {diagnostic.code} {sourceLocation(source, diagnostic.span.startByte)}
                    </span>
                    <span className="diagnostic-message">{diagnostic.message}</span>
                  </Button>
                ))}
                {result.kind !== "infrastructure-failure" &&
                  examples.kind !== "failure" &&
                  diagnostics.length === 0 && (
                    <p className="empty-diagnostics">
                      {success === undefined
                        ? "No diagnostics yet."
                        : "No diagnostics. The program compiled cleanly."}
                    </p>
                  )}
              </div>
            </div>

            <p className="adapter-name">
              {success === undefined
                ? "Adapter not initialized"
                : `${success.adapterName} · startup ${formatDuration(success.startupMilliseconds)}`}
            </p>
          </div>
        </section>

        <section className="explanation" aria-label="How the demo works">
          <p className="explanation-lead">No smoke. No mirrors.</p>
          <div className="explanation-grid">
            <p>
              The Lazuli parser is a small Wasm module generated by{" "}
              <a href="https://github.com/mewhhaha/baba">Baba</a>. Semantic compilation runs as
              bounded compute-shader transitions on your WebGPU adapter.
            </p>
            <p>
              The emitted artifact is normal WebAssembly. The GPU is only needed while compiling;
              the resulting <code>.wasm</code> runs anywhere with a compatible Wasm engine.
            </p>
          </div>
        </section>
      </main>

      <footer>
        <span>MIT licensed · built with React, comp0, WebGPU, and unreasonable optimism</span>
        <span>Compiler execution stays in your browser</span>
      </footer>
    </>
  );
}

interface PipelineStageProps {
  readonly index: string;
  readonly name: string;
  readonly time: string;
  readonly runtime: string;
  readonly featured?: boolean;
}

function PipelineStage({ index, name, time, runtime, featured }: PipelineStageProps) {
  return (
    <div className={`pipeline-stage${featured ? " featured" : ""}`}>
      <span className="stage-index">{index}</span>
      <span className="stage-name">{name}</span>
      <output className="stage-time">{time}</output>
      <span className="stage-runtime">{runtime}</span>
    </div>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function statusPresentation(
  result: ResultState,
  webGpuSupported: boolean,
): { readonly label: string; readonly tone: "idle" | "working" | "success" | "failure" } {
  if (!webGpuSupported) return { label: "Unsupported browser", tone: "failure" };
  switch (result.kind) {
    case "idle":
      return { label: "Ready", tone: "idle" };
    case "working":
      return { label: result.progress, tone: "working" };
    case "infrastructure-failure":
      return { label: "Infrastructure error", tone: "failure" };
    case "complete":
      return result.result.kind === "success"
        ? { label: "Compiled", tone: "success" }
        : { label: result.result.label, tone: "failure" };
  }
}
