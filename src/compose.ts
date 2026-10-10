import { CompositionError, type LoadIssue } from "./errors";
import {
  EXTENDS_KEY,
  PARAMETERS_KEY,
  readHeader,
  type ParameterDeclaration,
} from "./header";
import { isJsonObject, isJsonValue, type JsonObject, type JsonValue, type Scalar } from "./json";
import { merge, unwrapReplace } from "./merge";
import { buildTree, escapePointer, nodeAt, segmentsOf, toJson, type TreeNode } from "./tree";

/**
 * The only I/O composition performs, injected so it runs in any runtime. `path` is a normalised POSIX path relative to whatever root the caller chose.
 */
export interface FileReader {
  read: (path: string) => Promise<string>;
}

export interface ComposeOptions {
  /** Array-valued keys that concatenate across `extends` instead of being replaced. Matched against the property name at any depth. */
  readonly concatenate?: ReadonlySet<string> | readonly string[];
  /**
   * Checks each document as authored, before its header is read: the entry file and every fragment reached through `extends`. Returned issues are raised together as a `CompositionError`.
   */
  readonly onDocument?: (json: JsonObject, file: string) => readonly LoadIssue[];
}

export interface ComposedJson {
  /** The merged document, with `extends` and `parameters` consumed and `$param` and `$replace` resolved. */
  readonly value: JsonValue;
  /** Every file read, entry first, in the order they were first reached. */
  readonly files: readonly string[];
  /**
   * The file and pointer a node of `value` was authored at. A pointer that leaves the merged value resolves to its nearest enclosing node that has an origin. Throws `RangeError` for a string that is not a JSON pointer.
   */
  readonly originOf: (pointer: string) => { readonly file: string; readonly pointer: string };
}

const PARAM_KEY = "$param";

/**
 * Resolves `relative` against the directory of `from`, normalising `.` and `..` segments.
 */
export function resolveRelative(from: string, relative: string): string {
  const segments = from.split("/").slice(0, -1);
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }

  return segments.join("/");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class Composer {
  readonly files: string[] = [];

  readonly #reader: Readonly<FileReader>;

  readonly #concatenate: ReadonlySet<string>;

  readonly #onDocument: ComposeOptions["onDocument"];

  constructor(reader: Readonly<FileReader>, options: Readonly<ComposeOptions>) {
    this.#reader = reader;
    this.#concatenate = new Set(options.concatenate);
    this.#onDocument = options.onDocument;
  }

  async load(
    file: string,
    supplied: ReadonlyMap<string, Scalar>,
    stack: readonly string[],
  ): Promise<TreeNode> {
    const referrer = stack[stack.length - 1] ?? file;
    if (stack.includes(file)) {
      throw new CompositionError([
        {
          message: `extends forms a cycle: ${[...stack, file].join(" -> ")}`,
          file: referrer,
          pointer: `/${EXTENDS_KEY}`,
        },
      ]);
    }
    if (!this.files.includes(file)) this.files.push(file);

    let text: string;
    try {
      text = await this.#reader.read(file);
    } catch (error) {
      throw new CompositionError([
        {
          message: `cannot read file: ${describe(error)}`,
          file: referrer,
          pointer: `/${EXTENDS_KEY}`,
        },
      ]);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new CompositionError([
        { message: `invalid JSON: ${describe(error)}`, file, pointer: "" },
      ]);
    }
    if (!isJsonValue(parsed) || !isJsonObject(parsed)) {
      throw new CompositionError([
        { message: "a document must be a JSON object", file, pointer: "" },
      ]);
    }
    const json: JsonObject = parsed;

    const documentIssues = this.#onDocument?.(json, file) ?? [];
    if (documentIssues.length > 0) throw new CompositionError(documentIssues);

    const fields = new Map(Object.entries(json));
    const { header, issues } = readHeader(fields, file);
    if (issues.length > 0) throw new CompositionError(issues);

    const body = Object.fromEntries(
      Object.entries(json).filter(([key]) => key !== EXTENDS_KEY && key !== PARAMETERS_KEY),
    );
    const resolved = this.#resolveParameters(file, header.parameters, supplied);

    // Sequential by construction: parents are read, and any error raised, in `extends` order.
    const inherited = await header.extends.reduce<Promise<TreeNode | undefined>>(
      async (previous, entry) => {
        const base = await previous;
        const parent = await this.load(resolveRelative(file, entry.path), entry.supplied, [
          ...stack,
          file,
        ]);

        return merge(base, parent, "", this.#concatenate);
      },
      Promise.resolve(undefined),
    );

    const own = this.#substitute(buildTree(body, { file, pointer: "" }), resolved, file);

    return merge(inherited, own, "", this.#concatenate);
  }

  #resolveParameters(
    file: string,
    declared: ReadonlyMap<string, ParameterDeclaration>,
    supplied: ReadonlyMap<string, Scalar>,
  ): ReadonlyMap<string, Scalar> {
    const issues: LoadIssue[] = [];
    const values = new Map<string, Scalar>();
    for (const name of supplied.keys()) {
      if (!declared.has(name)) {
        issues.push({
          message: `the extending file supplies "${name}", which this file does not declare`,
          file,
          pointer: `/${PARAMETERS_KEY}`,
        });
      }
    }
    for (const [name, declaration] of declared) {
      const value = supplied.get(name) ?? declaration.default;
      const pointer = `/${PARAMETERS_KEY}/${escapePointer(name)}`;
      if (value === undefined) {
        issues.push({ message: `parameter "${name}" has no value and no default`, file, pointer });
      } else if (typeof value !== declaration.type) {
        issues.push({ message: `parameter "${name}" must be a ${declaration.type}`, file, pointer });
      } else {
        values.set(name, value);
      }
    }
    if (issues.length > 0) throw new CompositionError(issues);

    return values;
  }

  #substitute(node: TreeNode, values: ReadonlyMap<string, Scalar>, file: string): TreeNode {
    if (node.kind === "object") {
      const reference = node.entries.get(PARAM_KEY);
      if (reference !== undefined && node.entries.size === 1) {
        const name = reference.kind === "leaf" ? reference.value : undefined;
        const value = typeof name === "string" ? values.get(name) : undefined;
        if (value === undefined) {
          throw new CompositionError([
            {
              message: `${PARAM_KEY} names a parameter this file does not declare`,
              file,
              pointer: reference.origin.pointer,
            },
          ]);
        }

        return { origin: node.origin, kind: "leaf", value };
      }

      return {
        origin: node.origin,
        kind: "object",
        entries: new Map(
          [...node.entries].map(([key, child]) => [key, this.#substitute(child, values, file)]),
        ),
      };
    }
    if (node.kind === "array") {
      return {
        origin: node.origin,
        kind: "array",
        items: node.items.map((item) => this.#substitute(item, values, file)),
      };
    }

    return node;
  }
}

/**
 * Reads a JSON document and everything it `extends`, and returns the merged value with the origin of every node.
 *
 * Composition: parents are merged in order and the file's own body is applied last. Objects deep-merge; arrays under a key named in `options.concatenate` concatenate; every other array and every scalar is replaced by the overriding file. A `{"$replace": <value>}` wrapper replaces the inherited value outright, and is unwrapped where there is nothing to replace. A `{"$param": "<name>"}` object is replaced by the parameter's value, supplied by the extending file's `with` or the declaration's `default`.
 *
 * Cycles, unreadable or unresolved files, invalid JSON, a non-object document, a malformed header, unknown, mistyped or missing parameters, and anything `options.onDocument` reports all raise `CompositionError`, each issue located at the node's source file and JSON pointer. Validating the merged value is the caller's job; map its paths back to sources with `originOf`.
 */
export async function composeJson(
  entry: string,
  reader: Readonly<FileReader>,
  options: Readonly<ComposeOptions> = {},
): Promise<ComposedJson> {
  const composer = new Composer(reader, options);
  const tree = unwrapReplace(await composer.load(entry, new Map(), []));

  return {
    value: toJson(tree),
    files: composer.files,
    originOf: (pointer) => nodeAt(tree, segmentsOf(pointer)).origin,
  };
}
