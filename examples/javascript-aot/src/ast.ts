import type { Span } from "../../../src/functional/abi.ts";

export interface JavaScriptAotModule {
  readonly name: string;
  readonly declarations: readonly JavaScriptAotDeclaration[];
  readonly span: Span;
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
  readonly simpleParameterList?: false;
  readonly parameterBoundNames?: readonly string[];
  readonly parameterInitializerCounts?: readonly number[];
  readonly parameterDefaults?: readonly (JavaScriptAotExpression | null)[];
  readonly requiresRuntimeModel?: true;
  readonly classMethods?: readonly JavaScriptAotClassMethod[];
  readonly body: readonly JavaScriptAotStatement[];
  readonly span: Span;
}

export interface JavaScriptAotClassMethod {
  readonly name: string;
  readonly value: Extract<JavaScriptAotExpression, { readonly kind: "function" }>;
  readonly span: Span;
}

export interface JavaScriptAotConstantDeclaration {
  readonly kind: "constant";
  readonly exported: boolean;
  readonly name: string;
  readonly value: JavaScriptAotExpression;
  readonly span: Span;
}

export type JavaScriptAotStatement =
  | {
    readonly kind: "function-declaration";
    readonly name: string;
    readonly parameters: readonly string[];
    readonly parameterLength?: number;
    readonly simpleParameterList?: false;
    readonly parameterBoundNames?: readonly string[];
    readonly parameterInitializerCounts?: readonly number[];
    readonly parameterDefaults?: readonly (JavaScriptAotExpression | null)[];
    readonly requiresRuntimeModel?: true;
    readonly classMethods?: readonly JavaScriptAotClassMethod[];
    readonly body: readonly JavaScriptAotStatement[];
    readonly span: Span;
  }
  | {
    readonly kind: "constant";
    readonly name: string;
    readonly value: JavaScriptAotExpression;
    readonly span: Span;
  }
  | {
    readonly kind: "mutable";
    readonly name: string;
    readonly value: JavaScriptAotExpression;
    readonly span: Span;
  }
  | {
    readonly kind: "var";
    readonly declarations: readonly {
      readonly name: string;
      readonly value: JavaScriptAotExpression | null;
      readonly span: Span;
    }[];
    readonly span: Span;
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
    readonly span: Span;
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
    readonly span: Span;
  }
  | {
    readonly kind: "return";
    readonly value: JavaScriptAotExpression;
    readonly span: Span;
  }
  | {
    readonly kind: "throw";
    readonly value: JavaScriptAotExpression;
    readonly span: Span;
  }
  | {
    readonly kind: "break";
    readonly span: Span;
  }
  | {
    readonly kind: "continue";
    readonly span: Span;
  }
  | {
    readonly kind: "expression";
    readonly value: JavaScriptAotExpression;
    readonly span: Span;
  }
  | {
    readonly kind: "if";
    readonly condition: JavaScriptAotExpression;
    readonly consequent: readonly JavaScriptAotStatement[];
    readonly alternate: readonly JavaScriptAotStatement[] | null;
    readonly span: Span;
  }
  | {
    readonly kind: "while";
    readonly condition: JavaScriptAotExpression;
    readonly body: readonly JavaScriptAotStatement[];
    readonly continueBody: readonly JavaScriptAotStatement[];
    readonly span: Span;
  }
  | {
    readonly kind: "block";
    readonly statements: readonly JavaScriptAotStatement[];
    readonly span: Span;
  }
  | {
    readonly kind: "try";
    readonly body: readonly JavaScriptAotStatement[];
    readonly catchName: string | null;
    readonly catchBody: readonly JavaScriptAotStatement[] | null;
    readonly finallyBody: readonly JavaScriptAotStatement[] | null;
    readonly span: Span;
  };

export type JavaScriptAotExpression =
  | { readonly kind: "number"; readonly value: number; readonly span: Span }
  | {
    readonly kind: "string";
    readonly value: string;
    readonly raw: string | null;
    readonly span: Span;
  }
  | { readonly kind: "boolean"; readonly value: boolean; readonly span: Span }
  | { readonly kind: "null"; readonly span: Span }
  | { readonly kind: "name"; readonly name: string; readonly span: Span }
  | {
    readonly kind: "array";
    readonly values: readonly JavaScriptAotExpression[];
    readonly span: Span;
  }
  | {
    readonly kind: "object";
    readonly properties: readonly {
      readonly name: string;
      readonly value: JavaScriptAotExpression;
      readonly span: Span;
    }[];
    readonly span: Span;
  }
  | {
    readonly kind: "function";
    readonly name: string | null;
    readonly thisMode: "dynamic" | "lexical";
    readonly parameters: readonly string[];
    readonly parameterLength?: number;
    readonly simpleParameterList?: false;
    readonly parameterBoundNames?: readonly string[];
    readonly parameterInitializerCounts?: readonly number[];
    readonly parameterDefaults?: readonly (JavaScriptAotExpression | null)[];
    readonly body: readonly JavaScriptAotStatement[];
    readonly span: Span;
  }
  | {
    readonly kind: "unary";
    readonly operator: "-" | "+" | "!" | "~" | "typeof" | "void";
    readonly value: JavaScriptAotExpression;
    readonly span: Span;
  }
  | {
    readonly kind: "binary";
    readonly operator: JavaScriptAotBinaryOperator;
    readonly left: JavaScriptAotExpression;
    readonly right: JavaScriptAotExpression;
    readonly span: Span;
  }
  | {
    readonly kind: "conditional";
    readonly condition: JavaScriptAotExpression;
    readonly consequent: JavaScriptAotExpression;
    readonly alternate: JavaScriptAotExpression;
    readonly span: Span;
  }
  | {
    readonly kind: "call";
    readonly callee: JavaScriptAotExpression;
    readonly arguments: readonly JavaScriptAotExpression[];
    readonly span: Span;
  }
  | {
    readonly kind: "new";
    readonly constructor: string;
    readonly arguments: readonly JavaScriptAotExpression[];
    readonly span: Span;
  }
  | {
    readonly kind: "property";
    readonly value: JavaScriptAotExpression;
    readonly name: string;
    readonly span: Span;
  }
  | {
    readonly kind: "index";
    readonly value: JavaScriptAotExpression;
    readonly index: JavaScriptAotExpression;
    readonly span: Span;
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
