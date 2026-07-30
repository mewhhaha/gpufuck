export type CompilerPerformanceAnnotation = string | number | boolean;

export interface CompilerPerformanceEvent {
  readonly stage: string;
  readonly startMilliseconds: number;
  readonly durationMilliseconds: number;
  readonly annotations: Readonly<Record<string, CompilerPerformanceAnnotation>>;
}

export interface CompilerPerformanceStageSummary {
  readonly stage: string;
  readonly calls: number;
  readonly totalMilliseconds: number;
  readonly maximumMilliseconds: number;
}

export interface CompilerPerformanceSpan {
  finish(annotations?: Record<string, CompilerPerformanceAnnotation>): void;
}

type Clock = () => number;

export class CompilerPerformanceTrace {
  readonly #clock: Clock;
  readonly #originMilliseconds: number;
  readonly #events: CompilerPerformanceEvent[] = [];

  constructor(clock: Clock = () => performance.now()) {
    this.#clock = clock;
    this.#originMilliseconds = clock();
  }

  start(stage: string): CompilerPerformanceSpan {
    const startMilliseconds = this.#clock();
    let finished = false;
    return Object.freeze({
      finish: (annotations: Record<string, CompilerPerformanceAnnotation> = {}) => {
        if (finished) {
          throw new Error(`compiler performance stage ${JSON.stringify(stage)} finished twice`);
        }
        finished = true;
        this.record(stage, startMilliseconds, annotations);
      },
    });
  }

  measure<Result>(
    stage: string,
    annotations: Record<string, CompilerPerformanceAnnotation>,
    compile: () => Result,
    annotate?: (result: Result) => void,
  ): Result {
    const startMilliseconds = this.#clock();
    let succeeded = false;
    try {
      const result = compile();
      annotate?.(result);
      succeeded = true;
      return result;
    } finally {
      if (!succeeded) annotations.failed = true;
      this.record(stage, startMilliseconds, annotations);
    }
  }

  async measureAsync<Result>(
    stage: string,
    annotations: Record<string, CompilerPerformanceAnnotation>,
    compile: () => Promise<Result>,
    annotate?: (result: Result) => void,
  ): Promise<Result> {
    const startMilliseconds = this.#clock();
    let succeeded = false;
    try {
      const result = await compile();
      annotate?.(result);
      succeeded = true;
      return result;
    } finally {
      if (!succeeded) annotations.failed = true;
      this.record(stage, startMilliseconds, annotations);
    }
  }

  snapshot(): readonly CompilerPerformanceEvent[] {
    return Object.freeze(
      [...this.#events].sort((left, right) =>
        left.startMilliseconds - right.startMilliseconds ||
        left.durationMilliseconds - right.durationMilliseconds
      ),
    );
  }

  private record(
    stage: string,
    startedAtMilliseconds: number,
    annotations: Record<string, CompilerPerformanceAnnotation>,
  ): void {
    const finishedAtMilliseconds = this.#clock();
    this.#events.push(Object.freeze({
      stage,
      startMilliseconds: startedAtMilliseconds - this.#originMilliseconds,
      durationMilliseconds: finishedAtMilliseconds - startedAtMilliseconds,
      annotations: Object.freeze({ ...annotations }),
    }));
  }
}

export function measureCompilerStage<Result>(
  trace: CompilerPerformanceTrace | undefined,
  stage: string,
  annotations: Record<string, CompilerPerformanceAnnotation>,
  compile: () => Result,
  annotate?: (result: Result) => void,
): Result {
  return trace === undefined ? compile() : trace.measure(stage, annotations, compile, annotate);
}

export async function measureCompilerStageAsync<Result>(
  trace: CompilerPerformanceTrace | undefined,
  stage: string,
  annotations: Record<string, CompilerPerformanceAnnotation>,
  compile: () => Promise<Result>,
  annotate?: (result: Result) => void,
): Promise<Result> {
  return trace === undefined
    ? await compile()
    : await trace.measureAsync(stage, annotations, compile, annotate);
}

export function summarizeCompilerPerformance(
  events: readonly CompilerPerformanceEvent[],
): readonly CompilerPerformanceStageSummary[] {
  const summaries = new Map<string, {
    calls: number;
    totalMilliseconds: number;
    maximumMilliseconds: number;
  }>();
  for (const event of events) {
    const summary = summaries.get(event.stage) ?? {
      calls: 0,
      totalMilliseconds: 0,
      maximumMilliseconds: 0,
    };
    summary.calls++;
    summary.totalMilliseconds += event.durationMilliseconds;
    summary.maximumMilliseconds = Math.max(summary.maximumMilliseconds, event.durationMilliseconds);
    summaries.set(event.stage, summary);
  }
  return Object.freeze(
    [...summaries.entries()].map(([stage, summary]) => Object.freeze({ stage, ...summary })),
  );
}

export function renderCompilerPerformanceTrace(
  events: readonly CompilerPerformanceEvent[],
): string {
  return JSON.stringify({
    traceEvents: events.map((event) => ({
      name: event.stage,
      cat: "compiler",
      ph: "X",
      ts: event.startMilliseconds * 1_000,
      dur: event.durationMilliseconds * 1_000,
      pid: 1,
      tid: 1,
      args: event.annotations,
    })),
  });
}
