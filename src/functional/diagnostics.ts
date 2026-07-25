import type { Diagnostic, SourceRange, Span } from "./abi.ts";

export interface SourceSpan {
  readonly module: string;
  readonly span: Span;
}

export interface LocatedDiagnostic extends Omit<Diagnostic, "span" | "related"> {
  readonly location: SourceSpan;
  readonly related?: readonly {
    readonly message: string;
    readonly location: SourceSpan;
  }[];
}

export function locateSpan(
  sources: readonly SourceRange[],
  span: Span,
): SourceSpan | undefined {
  let boundaryMatch: SourceRange | undefined;
  for (const source of sources) {
    if (span.startByte < source.startByte || span.endByte > source.endByte) continue;
    if (span.startByte < source.endByte || source.startByte === source.endByte) {
      return {
        module: source.module,
        span: {
          startByte: span.startByte - source.startByte,
          endByte: span.endByte - source.startByte,
        },
      };
    }
    boundaryMatch = source;
  }
  if (boundaryMatch === undefined) return undefined;
  return {
    module: boundaryMatch.module,
    span: {
      startByte: span.startByte - boundaryMatch.startByte,
      endByte: span.endByte - boundaryMatch.startByte,
    },
  };
}

export function locateDiagnostic(
  sources: readonly SourceRange[],
  diagnostic: Diagnostic,
): LocatedDiagnostic | undefined {
  const location = locateSpan(sources, diagnostic.span);
  if (location === undefined) return undefined;
  const related = diagnostic.related?.flatMap((entry) => {
    const relatedLocation = locateSpan(sources, entry.span);
    return relatedLocation === undefined
      ? []
      : [{ message: entry.message, location: relatedLocation }];
  });
  return {
    stage: diagnostic.stage,
    code: diagnostic.code,
    message: diagnostic.message,
    location,
    ...(related === undefined ? {} : { related }),
  };
}
