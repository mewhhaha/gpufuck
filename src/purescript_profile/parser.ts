import { createParser } from "@mewhhaha/baba/runtime/generated-wasm";
import {
  babaChildRule,
  babaOptionalRuleField,
  babaRequiredRuleField,
  babaRequiredTokenField,
  type BabaRuleCursor,
  babaRuleFieldArray,
  babaTokenFieldArray,
  BabaUtf8ByteOffsets,
  isBabaRuleCursor,
} from "../baba_frontend.ts";

type PureScriptParser = ReturnType<typeof createParser>;

export interface ParsedPureScriptTypeProfile {
  readonly moduleName: string;
  readonly imports: readonly string[];
  readonly newtypes: readonly {
    readonly name: string;
    readonly parameters: readonly string[];
    readonly span: { readonly startByte: number; readonly endByte: number };
  }[];
  readonly classes: readonly {
    readonly name: string;
    readonly parameters: readonly string[];
    readonly dependency: {
      readonly inputs: readonly string[];
      readonly outputs: readonly string[];
    } | null;
    readonly span: { readonly startByte: number; readonly endByte: number };
  }[];
  readonly instances: readonly {
    readonly name: string;
    readonly className: string;
    readonly span: { readonly startByte: number; readonly endByte: number };
  }[];
  readonly signatures: readonly {
    readonly name: string;
    readonly hasOpenRow: boolean;
    readonly acceptsPolymorphicArgument: boolean;
    readonly span: { readonly startByte: number; readonly endByte: number };
  }[];
  readonly definitions: readonly string[];
  readonly span: { readonly startByte: number; readonly endByte: number };
}

export class PureScriptProfileSyntaxError extends Error {
  constructor(
    readonly span: { readonly startByte: number; readonly endByte: number },
    message: string,
  ) {
    super(message);
    this.name = "PureScriptProfileSyntaxError";
  }
}

let pureScriptParser: PureScriptParser | undefined;

export function parsePureScriptTypeProfile(source: string): ParsedPureScriptTypeProfile {
  const byteOffsets = new BabaUtf8ByteOffsets(source);
  const parsed = getPureScriptParser().parse(source, { preserveTrivia: false });
  if (!parsed.ok) {
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic === undefined) {
      throw new Error("Baba failed to parse the PureScript type profile without diagnostics.");
    }
    throw new PureScriptProfileSyntaxError(
      byteOffsets.span(diagnostic.span),
      `PureScript profile: ${diagnostic.code}: ${diagnostic.message}`,
    );
  }

  const header = babaRequiredRuleField(parsed.cursor, "header");
  const newtypes: ParsedPureScriptTypeProfile["newtypes"][number][] = [];
  const classes: ParsedPureScriptTypeProfile["classes"][number][] = [];
  const instances: ParsedPureScriptTypeProfile["instances"][number][] = [];
  const signatures: ParsedPureScriptTypeProfile["signatures"][number][] = [];
  const definitions: string[] = [];
  for (const declarationNode of babaRuleFieldArray(parsed.cursor, "declarations")) {
    const declaration = babaChildRule(declarationNode);
    switch (declaration.name) {
      case "newtype_declaration":
        newtypes.push({
          name: babaRequiredTokenField(declaration, "name").text,
          parameters: babaTokenFieldArray(declaration, "parameters").map((token) => token.text),
          span: byteOffsets.span(declaration.span),
        });
        break;
      case "class_declaration": {
        const dependency = babaOptionalRuleField(declaration, "dependency");
        classes.push({
          name: babaRequiredTokenField(declaration, "name").text,
          parameters: babaTokenFieldArray(declaration, "parameters").map((token) => token.text),
          dependency: dependency === null ? null : {
            inputs: identifierWords(babaRequiredRuleField(dependency, "inputs")),
            outputs: identifierWords(babaRequiredRuleField(dependency, "outputs")),
          },
          span: byteOffsets.span(declaration.span),
        });
        break;
      }
      case "instance_declaration":
        instances.push({
          name: babaRequiredTokenField(declaration, "name").text,
          className: babaRequiredTokenField(declaration, "class").text,
          span: byteOffsets.span(declaration.span),
        });
        break;
      case "type_signature": {
        const type = babaRequiredRuleField(declaration, "type");
        signatures.push({
          name: babaRequiredTokenField(declaration, "name").text,
          hasOpenRow: containsRule(type, "row_tail"),
          acceptsPolymorphicArgument: acceptsPolymorphicArgument(type),
          span: byteOffsets.span(declaration.span),
        });
        break;
      }
      case "value_definition":
        definitions.push(babaRequiredTokenField(declaration, "name").text);
        break;
      default:
        throw new Error(`Unsupported Baba PureScript profile declaration ${declaration.name}.`);
    }
  }

  return Object.freeze({
    moduleName: joinedName(babaRequiredRuleField(header, "name")),
    imports: Object.freeze(
      babaRuleFieldArray(parsed.cursor, "imports").map((imported) =>
        joinedName(babaRequiredRuleField(imported, "module"))
      ),
    ),
    newtypes: Object.freeze(newtypes),
    classes: Object.freeze(classes),
    instances: Object.freeze(instances),
    signatures: Object.freeze(signatures),
    definitions: Object.freeze(definitions),
    span: { startByte: 0, endByte: byteOffsets.byteLength },
  });
}

function getPureScriptParser(): PureScriptParser {
  if (pureScriptParser !== undefined) return pureScriptParser;
  pureScriptParser = createParser({
    bytes: Deno.readFileSync(
      new URL("../../language/purescript/generated/wasm/parser.wasm", import.meta.url),
    ),
    plan: Deno.readFileSync(
      new URL("../../language/purescript/generated/wasm/parser.plan", import.meta.url),
    ),
  });
  return pureScriptParser;
}

function acceptsPolymorphicArgument(type: BabaRuleCursor): boolean {
  const functionType = findRule(type, "function_type");
  if (functionType === null) return false;
  const parameter = babaRequiredRuleField(functionType, "parameter");
  return containsRule(parameter, "forall_type");
}

function containsRule(node: BabaRuleCursor, name: string): boolean {
  return findRule(node, name) !== null;
}

function findRule(node: BabaRuleCursor, name: string): BabaRuleCursor | null {
  if (node.name === name) return node;
  for (const child of node.children()) {
    if (!isBabaRuleCursor(child)) continue;
    const found = findRule(child, name);
    if (found !== null) return found;
  }
  return null;
}

function identifierWords(node: BabaRuleCursor): readonly string[] {
  return [
    babaRequiredTokenField(node, "head").text,
    ...babaTokenFieldArray(node, "tail").map((token) => token.text),
  ];
}

function joinedName(node: BabaRuleCursor): string {
  return [
    babaRequiredTokenField(node, "head").text,
    ...babaRuleFieldArray(node, "tail").map((tail) => babaRequiredTokenField(tail, "value").text),
  ].join(".");
}
