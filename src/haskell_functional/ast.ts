import type { FunctionalSpan } from "../functional/abi.ts";

export interface HaskellFunctionalProgram {
  readonly moduleName: string;
  readonly declarations: readonly HaskellFunctionalDeclaration[];
  readonly span: FunctionalSpan;
}

export type HaskellFunctionalDeclaration =
  | HaskellFunctionalTypeDeclaration
  | HaskellFunctionalTypeAliasDeclaration
  | HaskellFunctionalTypeSignature
  | HaskellFunctionalDefinition
  | HaskellFunctionalClassDeclaration
  | HaskellFunctionalInstanceDeclaration;

export interface HaskellFunctionalClassDeclaration {
  readonly kind: "class";
  readonly name: string;
  readonly parameter: string;
  readonly methods: readonly HaskellFunctionalTypeSignature[];
  readonly span: FunctionalSpan;
}

export interface HaskellFunctionalInstanceDeclaration {
  readonly kind: "instance";
  readonly className: string;
  readonly type: HaskellFunctionalType;
  readonly methods: readonly HaskellFunctionalDefinition[];
  readonly span: FunctionalSpan;
}

export interface HaskellFunctionalTypeDeclaration {
  readonly kind: "type";
  readonly representation: "data" | "newtype";
  readonly name: string;
  readonly parameters: readonly string[];
  readonly constructors: readonly HaskellFunctionalConstructor[];
  readonly span: FunctionalSpan;
}

export interface HaskellFunctionalTypeAliasDeclaration {
  readonly kind: "type-alias";
  readonly name: string;
  readonly parameters: readonly string[];
  readonly target: HaskellFunctionalType;
  readonly span: FunctionalSpan;
}

export interface HaskellFunctionalConstructor {
  readonly name: string;
  readonly fields: readonly HaskellFunctionalConstructorField[];
  readonly result?: HaskellFunctionalType;
  readonly record: boolean;
  readonly span: FunctionalSpan;
}

export interface HaskellFunctionalConstructorField {
  readonly name: string | null;
  readonly type: HaskellFunctionalType;
  readonly span: FunctionalSpan;
}

export interface HaskellFunctionalTypeSignature {
  readonly kind: "signature";
  readonly name: string;
  readonly constraints: readonly HaskellFunctionalConstraint[];
  readonly type: HaskellFunctionalType;
  readonly span: FunctionalSpan;
}

export interface HaskellFunctionalConstraint {
  readonly className: string;
  readonly type: HaskellFunctionalType;
  readonly span: FunctionalSpan;
}

export interface HaskellFunctionalDefinition {
  readonly kind: "definition";
  readonly name: string;
  readonly parameters: readonly HaskellFunctionalPattern[];
  readonly alternatives: readonly HaskellFunctionalGuardedBody[];
  readonly whereDefinitions: readonly HaskellFunctionalDefinition[];
  readonly span: FunctionalSpan;
}

export interface HaskellFunctionalGuardedBody {
  readonly condition: HaskellFunctionalExpression | null;
  readonly body: HaskellFunctionalExpression;
  readonly span: FunctionalSpan;
}

export type HaskellFunctionalType =
  | { readonly kind: "integer"; readonly span: FunctionalSpan }
  | { readonly kind: "character"; readonly span: FunctionalSpan }
  | { readonly kind: "boolean"; readonly span: FunctionalSpan }
  | { readonly kind: "unit"; readonly span: FunctionalSpan }
  | { readonly kind: "list"; readonly value: HaskellFunctionalType; readonly span: FunctionalSpan }
  | { readonly kind: "parameter"; readonly name: string; readonly span: FunctionalSpan }
  | {
    readonly kind: "tuple";
    readonly values: readonly [HaskellFunctionalType, HaskellFunctionalType];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "named";
    readonly name: string;
    readonly arguments: readonly HaskellFunctionalType[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "function";
    readonly parameter: HaskellFunctionalType;
    readonly result: HaskellFunctionalType;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "forall";
    readonly parameters: readonly string[];
    readonly body: HaskellFunctionalType;
    readonly span: FunctionalSpan;
  };

export type HaskellFunctionalExpression =
  | { readonly kind: "integer"; readonly value: number; readonly span: FunctionalSpan }
  | { readonly kind: "character"; readonly value: number; readonly span: FunctionalSpan }
  | { readonly kind: "string"; readonly values: readonly number[]; readonly span: FunctionalSpan }
  | { readonly kind: "boolean"; readonly value: boolean; readonly span: FunctionalSpan }
  | { readonly kind: "unit"; readonly span: FunctionalSpan }
  | {
    readonly kind: "tuple";
    readonly values: readonly [HaskellFunctionalExpression, HaskellFunctionalExpression];
    readonly span: FunctionalSpan;
  }
  | { readonly kind: "name"; readonly name: string; readonly span: FunctionalSpan }
  | {
    readonly kind: "record";
    readonly constructor: string;
    readonly fields: readonly HaskellFunctionalRecordField[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "lambda";
    readonly parameters: readonly string[];
    readonly body: HaskellFunctionalExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "list";
    readonly values: readonly HaskellFunctionalExpression[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "list-cons";
    readonly head: HaskellFunctionalExpression;
    readonly tail: HaskellFunctionalExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "apply";
    readonly callee: HaskellFunctionalExpression;
    readonly argument: HaskellFunctionalExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "let";
    readonly bindings: readonly HaskellFunctionalDefinition[];
    readonly body: HaskellFunctionalExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "if";
    readonly condition: HaskellFunctionalExpression;
    readonly consequent: HaskellFunctionalExpression;
    readonly alternate: HaskellFunctionalExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "binary";
    readonly operator: HaskellFunctionalBinaryOperator;
    readonly left: HaskellFunctionalExpression;
    readonly right: HaskellFunctionalExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "case";
    readonly value: HaskellFunctionalExpression;
    readonly arms: readonly HaskellFunctionalCaseArm[];
    readonly span: FunctionalSpan;
  };

export type HaskellFunctionalBinding = HaskellFunctionalDefinition;

export interface HaskellFunctionalRecordField {
  readonly name: string;
  readonly value: HaskellFunctionalExpression;
  readonly span: FunctionalSpan;
}

export interface HaskellFunctionalCaseArm {
  readonly pattern: HaskellFunctionalPattern;
  readonly body: HaskellFunctionalExpression;
  readonly span: FunctionalSpan;
}

export type HaskellFunctionalPattern =
  | {
    readonly kind: "variable";
    readonly name: string;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "wildcard";
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "constructor";
    readonly constructor: string;
    readonly arguments: readonly HaskellFunctionalPattern[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "tuple";
    readonly values: readonly [HaskellFunctionalPattern, HaskellFunctionalPattern];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "list-nil";
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "list-cons";
    readonly head: HaskellFunctionalPattern;
    readonly tail: HaskellFunctionalPattern;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "record";
    readonly constructor: string;
    readonly fields: readonly HaskellFunctionalRecordPatternField[];
    readonly span: FunctionalSpan;
  };

export interface HaskellFunctionalRecordPatternField {
  readonly name: string;
  readonly pattern: HaskellFunctionalPattern;
  readonly span: FunctionalSpan;
}

export type HaskellFunctionalBinaryOperator =
  | "=="
  | "/="
  | "<"
  | "<="
  | ">"
  | ">="
  | "+"
  | "-"
  | "*"
  | "/";
