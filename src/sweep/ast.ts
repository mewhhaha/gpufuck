/**
 * Syntax for Sweep, the language DESIGN.md argues for.
 *
 * Every construct here exists to keep compilation a bottom-up sweep rather than a global solve. The
 * shape of the AST is itself part of that argument: there is no unannotated binding, no nested
 * pattern, and no implicit type argument, so a checker never has to guess and never has to
 * backtrack.
 *
 * @module
 */

export interface SweepSpan {
  readonly startByte: number;
  readonly endByte: number;
}

/**
 * Rule 6: nominal only. A type is a name applied to arguments, a function arrow, or a bound
 * parameter — never a structural alias, so there is nothing for an occurs check to chase.
 */
export type SweepType =
  | { readonly kind: "name"; readonly name: string; readonly arguments: readonly SweepType[] }
  | { readonly kind: "parameter"; readonly name: string }
  | {
    readonly kind: "function";
    readonly parameters: readonly SweepType[];
    readonly result: SweepType;
  };

export interface SweepField {
  readonly name: string;
  readonly type: SweepType;
}

export interface SweepConstructor {
  readonly name: string;
  readonly fields: readonly SweepField[];
  readonly span: SweepSpan;
}

export interface SweepTypeDeclaration {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly constructors: readonly SweepConstructor[];
  readonly span: SweepSpan;
}

/**
 * Rule 4: a match arm names one constructor and binds its fields positionally. There is no nesting
 * and no or-pattern, so an arm lowers to exactly one Core arm and a body is never duplicated.
 */
export interface SweepArm {
  readonly constructor: string;
  readonly binders: readonly string[];
  readonly body: SweepExpression;
  readonly span: SweepSpan;
}

export type SweepExpression =
  | { readonly kind: "integer"; readonly value: number; readonly span: SweepSpan }
  | { readonly kind: "boolean"; readonly value: boolean; readonly span: SweepSpan }
  | { readonly kind: "name"; readonly name: string; readonly span: SweepSpan }
  /** Rule 2: type arguments are written, never inferred. */
  | {
    readonly kind: "call";
    readonly callee: string;
    readonly typeArguments: readonly SweepType[];
    readonly arguments: readonly SweepExpression[];
    readonly span: SweepSpan;
  }
  | {
    readonly kind: "construct";
    readonly constructor: string;
    readonly arguments: readonly SweepExpression[];
    readonly span: SweepSpan;
  }
  | {
    readonly kind: "binary";
    readonly operator: SweepBinaryOperator;
    readonly left: SweepExpression;
    readonly right: SweepExpression;
    readonly span: SweepSpan;
  }
  /** Rule 5: `name` is unique within its function, so resolution is a table lookup. */
  | {
    readonly kind: "let";
    readonly name: string;
    readonly type: SweepType;
    readonly value: SweepExpression;
    readonly body: SweepExpression;
    readonly span: SweepSpan;
  }
  | {
    readonly kind: "if";
    readonly condition: SweepExpression;
    readonly consequent: SweepExpression;
    readonly alternate: SweepExpression;
    readonly span: SweepSpan;
  }
  | {
    readonly kind: "match";
    readonly subject: SweepExpression;
    readonly arms: readonly SweepArm[];
    readonly span: SweepSpan;
  };

export type SweepBinaryOperator =
  | "add"
  | "subtract"
  | "multiply"
  | "less"
  | "less-equal"
  | "greater"
  | "greater-equal"
  | "equal";

export interface SweepParameter {
  readonly name: string;
  readonly type: SweepType;
}

/**
 * Rules 1 and 3: every parameter and the result carry a type, and the parameter list is n-ary in
 * the syntax. The arity cost measured in BASELINE.md is paid by the lowering, not the language.
 */
export interface SweepFunction {
  readonly name: string;
  readonly typeParameters: readonly string[];
  readonly parameters: readonly SweepParameter[];
  readonly result: SweepType;
  readonly body: SweepExpression;
  readonly span: SweepSpan;
}

/** Rule 7: the interface is written down, so a module needs nothing inferred from its dependents. */
export interface SweepModule {
  readonly name: string;
  readonly exports: readonly string[];
  readonly types: readonly SweepTypeDeclaration[];
  readonly functions: readonly SweepFunction[];
}
