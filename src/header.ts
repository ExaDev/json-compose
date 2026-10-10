import type { LoadIssue } from "./errors";
import { isJsonArray, isJsonObject, isScalar, type JsonValue, type Scalar } from "./json";
import { pointerOf } from "./tree";

export const EXTENDS_KEY = "extends";
export const PARAMETERS_KEY = "parameters";

const PARAMETER_TYPES = ["string", "number", "boolean"] as const;
export type ParameterType = (typeof PARAMETER_TYPES)[number];

export interface ExtendsEntry {
  readonly path: string;
  /** Parameter values the extending file supplies to the parent. */
  readonly supplied: ReadonlyMap<string, Scalar>;
}

export interface ParameterDeclaration {
  readonly type: ParameterType;
  readonly default: Scalar | undefined;
}

/** Collects issues while a header is narrowed, so the narrowing functions stay free of array out-parameters. */
class IssueSink {
  readonly issues: LoadIssue[] = [];

  add(issue: LoadIssue): void {
    this.issues.push(issue);
  }

  addAll(issues: readonly LoadIssue[]): void {
    this.issues.push(...issues);
  }
}

export interface Header {
  readonly extends: readonly ExtendsEntry[];
  readonly parameters: ReadonlyMap<string, ParameterDeclaration>;
}

function isParameterType(value: unknown): value is ParameterType {
  return PARAMETER_TYPES.some((type) => type === value);
}

function unrecognisedKeys(
  value: Readonly<Record<string, JsonValue>>,
  allowed: readonly string[],
  file: string,
  base: readonly string[],
): LoadIssue[] {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => ({
      message: `unrecognised key "${key}"`,
      file,
      pointer: pointerOf([...base, key]),
    }));
}

function readSupplied(
  value: JsonValue,
  file: string,
  base: readonly string[],
  issues: IssueSink,
): ReadonlyMap<string, Scalar> {
  const supplied = new Map<string, Scalar>();
  if (!isJsonObject(value)) {
    issues.add({ message: "must be an object of parameter values", file, pointer: pointerOf(base) });

    return supplied;
  }
  for (const [name, entry] of Object.entries(value)) {
    if (isScalar(entry)) {
      supplied.set(name, entry);
    } else {
      issues.add({
        message: "a parameter value must be a string, number or boolean",
        file,
        pointer: pointerOf([...base, name]),
      });
    }
  }

  return supplied;
}

function readEntry(
  value: JsonValue,
  file: string,
  base: readonly string[],
  issues: IssueSink,
): ExtendsEntry | undefined {
  if (typeof value === "string") {
    if (value === "") {
      issues.add({ message: "must not be empty", file, pointer: pointerOf(base) });

      return undefined;
    }

    return { path: value, supplied: new Map() };
  }
  if (!isJsonObject(value)) {
    issues.add({
      message: "must be a path string or an object with a path",
      file,
      pointer: pointerOf(base),
    });

    return undefined;
  }

  issues.addAll(unrecognisedKeys(value, ["path", "with"], file, base));
  const fields = new Map(Object.entries(value));
  const path = fields.get("path");
  const supplied = fields.get("with");
  if (typeof path !== "string" || path === "") {
    issues.add({
      message: "must have a non-empty string path",
      file,
      pointer: pointerOf([...base, "path"]),
    });

    return undefined;
  }

  return {
    path,
    supplied:
      supplied === undefined
        ? new Map()
        : readSupplied(supplied, file, [...base, "with"], issues),
  };
}

function readExtends(
  value: JsonValue | undefined,
  file: string,
  issues: IssueSink,
): readonly ExtendsEntry[] {
  if (value === undefined) return [];
  const base = [EXTENDS_KEY];
  const entries = isJsonArray(value)
    ? value.map((item, index) => readEntry(item, file, [...base, String(index)], issues))
    : [readEntry(value, file, base, issues)];

  return entries.filter((entry) => entry !== undefined);
}

function readParameters(
  value: JsonValue | undefined,
  file: string,
  issues: IssueSink,
): ReadonlyMap<string, ParameterDeclaration> {
  const declared = new Map<string, ParameterDeclaration>();
  if (value === undefined) return declared;
  if (!isJsonObject(value)) {
    issues.add({
      message: "must be an object of parameter declarations",
      file,
      pointer: pointerOf([PARAMETERS_KEY]),
    });

    return declared;
  }
  for (const [name, declaration] of Object.entries(value)) {
    const base = [PARAMETERS_KEY, name];
    if (!isJsonObject(declaration)) {
      issues.add({ message: "must be a parameter declaration object", file, pointer: pointerOf(base) });
      continue;
    }
    issues.addAll(unrecognisedKeys(declaration, ["type", "default", "description"], file, base));
    const fields = new Map(Object.entries(declaration));
    const type = fields.get("type");
    const fallback = fields.get("default");
    const description = fields.get("description");
    if (!isParameterType(type)) {
      issues.add({
        message: 'type must be "string", "number" or "boolean"',
        file,
        pointer: pointerOf([...base, "type"]),
      });
      continue;
    }
    if (fallback !== undefined && !isScalar(fallback)) {
      issues.add({
        message: "default must be a string, number or boolean",
        file,
        pointer: pointerOf([...base, "default"]),
      });
      continue;
    }
    if (description !== undefined && typeof description !== "string") {
      issues.add({
        message: "description must be a string",
        file,
        pointer: pointerOf([...base, "description"]),
      });
      continue;
    }
    declared.set(name, { type, default: fallback });
  }

  return declared;
}

/**
 * Narrows the `extends` and `parameters` members of a document by hand. Every defect is collected, located at the member it concerns, and returned rather than thrown so the caller reports them together.
 */
export function readHeader(
  fields: ReadonlyMap<string, JsonValue>,
  file: string,
): { readonly header: Header; readonly issues: readonly LoadIssue[] } {
  const issues = new IssueSink();
  const header: Header = {
    extends: readExtends(fields.get(EXTENDS_KEY), file, issues),
    parameters: readParameters(fields.get(PARAMETERS_KEY), file, issues),
  };

  return { header, issues: issues.issues };
}
