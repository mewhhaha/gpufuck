import type { FunctionalDiagnostic, FunctionalSourceRange, FunctionalSpan } from "./abi.ts";

export interface FunctionalSourceSpan {
  readonly module: string;
  readonly span: FunctionalSpan;
}

export interface FunctionalLocatedDiagnostic
  extends Omit<FunctionalDiagnostic, "span" | "related"> {
  readonly location: FunctionalSourceSpan;
  readonly related?: readonly {
    readonly message: string;
    readonly location: FunctionalSourceSpan;
  }[];
}

export function locateFunctionalSpan(
  sources: readonly FunctionalSourceRange[],
  span: FunctionalSpan,
): FunctionalSourceSpan | undefined {
  let boundaryMatch: FunctionalSourceRange | undefined;
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

export function locateFunctionalDiagnostic(
  sources: readonly FunctionalSourceRange[],
  diagnostic: FunctionalDiagnostic,
): FunctionalLocatedDiagnostic | undefined {
  const location = locateFunctionalSpan(sources, diagnostic.span);
  if (location === undefined) return undefined;
  const related = diagnostic.related?.flatMap((entry) => {
    const relatedLocation = locateFunctionalSpan(sources, entry.span);
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
