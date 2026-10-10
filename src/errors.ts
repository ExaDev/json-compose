export interface LoadIssue {
  readonly message: string;
  /** The file the offending node was authored in, which may be a fragment reached through `extends`. */
  readonly file: string;
  /** JSON pointer to the node within that file. */
  readonly pointer: string;
}

/**
 * Raised for every defect found while composing a document: unreadable or malformed JSON, an unresolved or cyclic `extends`, a malformed `extends` or `parameters` header, a bad parameter, or an issue reported by the `onDocument` hook. Each issue names the source file and JSON pointer of the node as authored, including across `extends` boundaries.
 */
export class CompositionError extends Error {
  readonly issues: readonly LoadIssue[];

  constructor(issues: readonly LoadIssue[]) {
    super(issues.map((issue) => `${issue.file}#${issue.pointer}: ${issue.message}`).join("\n"));
    this.name = "CompositionError";
    this.issues = issues;
  }
}
