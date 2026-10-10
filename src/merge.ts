import type { TreeNode } from "./tree";

export const REPLACE_KEY = "$replace";

export function replaceMarkerTarget(node: TreeNode): TreeNode | undefined {
  if (node.kind === "object" && node.entries.size === 1) {
    return node.entries.get(REPLACE_KEY);
  }

  return undefined;
}

/**
 * Applies `over` on top of `base`. `key` is the property name `over` sits under, which decides whether two arrays concatenate.
 */
export function merge(
  base: TreeNode | undefined,
  over: TreeNode,
  key: string,
  concatenate: ReadonlySet<string>,
): TreeNode {
  const replacement = replaceMarkerTarget(over);
  if (replacement !== undefined) return replacement;
  if (base === undefined) return over;
  if (base.kind === "object" && over.kind === "object") {
    const entries = new Map(base.entries);
    for (const [childKey, child] of over.entries) {
      entries.set(childKey, merge(base.entries.get(childKey), child, childKey, concatenate));
    }

    return { origin: over.origin, kind: "object", entries };
  }
  if (base.kind === "array" && over.kind === "array" && concatenate.has(key)) {
    return { origin: over.origin, kind: "array", items: [...base.items, ...over.items] };
  }

  return over;
}

/** Removes every `$replace` wrapper that survived because it had no base to replace. */
export function unwrapReplace(node: TreeNode): TreeNode {
  const replacement = replaceMarkerTarget(node);
  if (replacement !== undefined) return unwrapReplace(replacement);
  if (node.kind === "object") {
    return {
      origin: node.origin,
      kind: "object",
      entries: new Map([...node.entries].map(([key, child]) => [key, unwrapReplace(child)])),
    };
  }
  if (node.kind === "array") {
    return { origin: node.origin, kind: "array", items: node.items.map(unwrapReplace) };
  }

  return node;
}
