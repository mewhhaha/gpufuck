import type { FunctionalSpan } from "../../../src/functional/abi.ts";

export interface JavaScriptAotModule {
  readonly name: string;
  readonly declarations: readonly JavaScriptAotDeclaration[];
  readonly span: FunctionalSpan;
}

export type JavaScriptAotDeclaration =
  | JavaScriptAotFunctionDeclaration
  | JavaScriptAotConstantDeclaration;

export interface JavaScriptAotFunctionDeclaration {
  readonly kind: "function";
  readonly exported: boolean;
  readonly name: string;
  readonly parameters: readonly string[];
  readonly parameterLength?: number;
  readonly requiresRuntimeModel?: true;
  readonly body: readonly JavaScriptAotStatement[];
  readonly span: FunctionalSpan;
}

export interface JavaScriptAotConstantDeclaration {
  readonly kind: "constant";
  readonly exported: boolean;
  readonly name: string;
  readonly value: JavaScriptAotExpression;
  readonly span: FunctionalSpan;
}

export type JavaScriptAotStatement =
  | {
    readonly kind: "function-declaration";
    readonly name: string;
    readonly parameters: readonly string[];
    readonly parameterLength?: number;
    readonly requiresRuntimeModel?: true;
    readonly body: readonly JavaScriptAotStatement[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "constant";
    readonly name: string;
    readonly value: JavaScriptAotExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "mutable";
    readonly name: string;
    readonly value: JavaScriptAotExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "var";
    readonly declarations: readonly {
      readonly name: string;
      readonly value: JavaScriptAotExpression | null;
      readonly span: FunctionalSpan;
    }[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "assignment";
    readonly name: string;
    readonly operator:
      | "="
      | "+="
      | "-="
      | "*="
      | "/="
      | "%="
      | "<<="
      | ">>="
      | ">>>="
      | "&="
      | "^="
      | "|=";
    readonly value: JavaScriptAotExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "property-assignment";
    readonly target: Extract<JavaScriptAotExpression, {
      readonly kind: "property" | "index";
    }>;
    readonly operator:
      | "="
      | "+="
      | "-="
      | "*="
      | "/="
      | "%="
      | "<<="
      | ">>="
      | ">>>="
      | "&="
      | "^="
      | "|=";
    readonly value: JavaScriptAotExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "return";
    readonly value: JavaScriptAotExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "throw";
    readonly value: JavaScriptAotExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "break";
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "continue";
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "expression";
    readonly value: JavaScriptAotExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "if";
    readonly condition: JavaScriptAotExpression;
    readonly consequent: readonly JavaScriptAotStatement[];
    readonly alternate: readonly JavaScriptAotStatement[] | null;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "while";
    readonly condition: JavaScriptAotExpression;
    readonly body: readonly JavaScriptAotStatement[];
    readonly continueBody: readonly JavaScriptAotStatement[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "block";
    readonly statements: readonly JavaScriptAotStatement[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "try";
    readonly body: readonly JavaScriptAotStatement[];
    readonly catchName: string | null;
    readonly catchBody: readonly JavaScriptAotStatement[] | null;
    readonly finallyBody: readonly JavaScriptAotStatement[] | null;
    readonly span: FunctionalSpan;
  };

export type JavaScriptAotExpression =
  | { readonly kind: "number"; readonly value: number; readonly span: FunctionalSpan }
  | {
    readonly kind: "string";
    readonly value: string;
    readonly raw: string | null;
    readonly span: FunctionalSpan;
  }
  | { readonly kind: "boolean"; readonly value: boolean; readonly span: FunctionalSpan }
  | { readonly kind: "null"; readonly span: FunctionalSpan }
  | { readonly kind: "name"; readonly name: string; readonly span: FunctionalSpan }
  | {
    readonly kind: "array";
    readonly values: readonly JavaScriptAotExpression[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "object";
    readonly properties: readonly {
      readonly name: string;
      readonly value: JavaScriptAotExpression;
      readonly span: FunctionalSpan;
    }[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "function";
    readonly name: string | null;
    readonly thisMode: "dynamic" | "lexical";
    readonly parameters: readonly string[];
    readonly parameterLength?: number;
    readonly body: readonly JavaScriptAotStatement[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "unary";
    readonly operator: "-" | "+" | "!" | "~" | "typeof" | "void";
    readonly value: JavaScriptAotExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "binary";
    readonly operator: JavaScriptAotBinaryOperator;
    readonly left: JavaScriptAotExpression;
    readonly right: JavaScriptAotExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "conditional";
    readonly condition: JavaScriptAotExpression;
    readonly consequent: JavaScriptAotExpression;
    readonly alternate: JavaScriptAotExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "call";
    readonly callee: JavaScriptAotExpression;
    readonly arguments: readonly JavaScriptAotExpression[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "new";
    readonly constructor: string;
    readonly arguments: readonly JavaScriptAotExpression[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "property";
    readonly value: JavaScriptAotExpression;
    readonly name: string;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "index";
    readonly value: JavaScriptAotExpression;
    readonly index: JavaScriptAotExpression;
    readonly span: FunctionalSpan;
  };

export type JavaScriptAotBinaryOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "<"
  | "<="
  | ">"
  | ">="
  | "<<"
  | ">>"
  | ">>>"
  | "&"
  | "^"
  | "|"
  | "instanceof"
  | "==="
  | "!=="
  | "same-value"
  | "not-same-value"
  | "=="
  | "!="
  | "&&"
  | "||";
