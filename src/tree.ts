import { isJsonArray, type JsonValue } from "./json";

export interface Origin {
  readonly file: string;
  readonly pointer: string;
}

/** A JSON value that remembers, for every node, the file and pointer it was authored at. */
export type TreeNode = { readonly origin: Origin } & (
  | { readonly kind: "leaf"; readonly value: string | number | boolean | null }
  | { readonly kind: "object"; readonly entries: ReadonlyMap<string, TreeNode> }
  | { readonly kind: "array"; readonly items: readonly TreeNode[] }
);

export function escapePointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function unescapePointer(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

export function pointerOf(segments: readonly string[]): string {
  return segments.map((segment) => `/${escapePointer(segment)}`).join("");
}

/** Splits an RFC 6901 pointer into its unescaped segments. */
export function segmentsOf(pointer: string): readonly string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new RangeError(`not a JSON pointer: ${JSON.stringify(pointer)}`);
  }

  return pointer.slice(1).split("/").map(unescapePointer);
}

export function buildTree(value: JsonValue, origin: Origin): TreeNode {
  if (isJsonArray(value)) {
    return {
      origin,
      kind: "array",
      items: value.map((item, index) =>
        buildTree(item, { file: origin.file, pointer: `${origin.pointer}/${String(index)}` }),
      ),
    };
  }
  if (typeof value === "object" && value !== null) {
    const entries = new Map<string, TreeNode>();
    for (const [key, child] of Object.entries(value)) {
      entries.set(
        key,
        buildTree(child, {
          file: origin.file,
          pointer: `${origin.pointer}/${escapePointer(key)}`,
        }),
      );
    }

    return { origin, kind: "object", entries };
  }

  return { origin, kind: "leaf", value };
}

/** Objects are built with `Object.fromEntries`, which defines own data properties, so a `__proto__` key survives as data. */
export function toJson(node: TreeNode): JsonValue {
  if (node.kind === "leaf") return node.value;
  if (node.kind === "array") return node.items.map(toJson);

  return Object.fromEntries([...node.entries].map(([key, child]) => [key, toJson(child)]));
}

/**
 * The node at `segments`, or the deepest node reached when the path leaves the tree, so every pointer in a merged value resolves to the nearest defined origin.
 */
export function nodeAt(root: TreeNode, segments: readonly string[]): TreeNode {
  let current = root;
  for (const segment of segments) {
    if (current.kind === "object") {
      const next = current.entries.get(segment);
      if (next === undefined) return current;
      current = next;
    } else if (current.kind === "array") {
      const next = current.items[Number(segment)];
      if (next === undefined) return current;
      current = next;
    } else {
      return current;
    }
  }

  return current;
}
