# @exadev/json-compose

Composes one JSON document from a file and the files it `extends`, and remembers which file and pointer every node of the result was authored at, so a validation error on the merged value can be reported against the source that caused it.

It does no validation of its own and has no runtime dependencies. File access is injected, so it runs wherever you can supply a `read(path)` function.

## Usage

```ts
import { readFile } from "node:fs/promises";
import { composeJson } from "@exadev/json-compose";

const composed = await composeJson(
  "ci/main.json",
  { read: (path) => readFile(path, "utf8") },
  { concatenate: ["steps"] },
);

composed.value; // the merged JSON
composed.files; // every file read, entry first
composed.originOf("/jobs/lint/timeout"); // { file: "ci/base.json", pointer: "/jobs/lint/timeout" }
```

```json
{
  "extends": ["./base.json", { "path": "./node-job.json", "with": { "version": 22 } }],
  "env": { "CI": "true" }
}
```

## API

`composeJson(entry, reader, options?)` resolves to a `ComposedJson`, or rejects with a `CompositionError`.

- `entry` is the path of the root document. Paths are POSIX, and `extends` paths resolve relative to the file that names them (`resolveRelative(from, relative)` is exported). Whatever root they are relative to is the reader's business.
- `reader` is `{ read(path: string): Promise<string> }`.
- `options.concatenate` is a set or array of property names whose array values concatenate across `extends`. The default is none.
- `options.onDocument(json, file)` runs on every document as authored, the entry and each fragment, before its `extends` and `parameters` are read. It returns issues; any returned are raised together. Use it for checks this package should not know about, such as requiring a `$schema` member.

`ComposedJson` has:

- `value`, the merged document with `extends`, `parameters`, `$param` and `$replace` consumed.
- `files`, every file read in the order first reached.
- `originOf(pointer)`, the `{ file, pointer }` a node was authored at. A pointer that does not exist in `value` resolves to its nearest enclosing node, so a path from a validator's error always has an answer. A string that is not an RFC 6901 pointer throws `RangeError`.

## Composition rules

A document is a JSON object. Two members are reserved and removed from the result.

`extends` is a path, an object `{ "path": "...", "with": { ... } }`, or an array of either. Parents are merged in order, then the document's own members are applied last.

Merging, where `over` is applied on top of `base`:

- Objects deep-merge, key by key.
- Arrays under a key listed in `concatenate` are `base` followed by `over`.
- Every other array, and every scalar, is replaced by `over`.
- `{ "$replace": value }` replaces whatever was inherited with `value` outright, whatever the types. Where there is nothing to replace it unwraps to `value`.

`parameters` declares values a file expects its extender to supply:

```json
{
  "parameters": {
    "version": { "type": "number" },
    "runner": { "type": "string", "default": "ubuntu-latest", "description": "Where it runs" }
  },
  "runsOn": { "$param": "runner" },
  "node": { "$param": "version" }
}
```

A declaration has a `type` (`string`, `number` or `boolean`), an optional `default` and an optional `description`. The extending file supplies values through `with`. A parameter needs a value or a default, the value must have the declared type, and a supplied name must be declared. A `{ "$param": "name" }` object is replaced by the value, wherever it appears in the declaring file. Parameters are scoped to the file that declares them: they are not inherited by, or visible to, files further up or down the chain.

A `__proto__` key in a document is an ordinary data property, in the input and in the result.

## Errors

Every defect raises `CompositionError`: unreadable or unparseable files, a document that is not an object, a malformed `extends` or `parameters` member, an `extends` cycle, a missing, mistyped or undeclared parameter, and anything `onDocument` returns.

`error.issues` is a list of `{ message, file, pointer }`, located at the node as authored, including inside fragments reached through `extends`. `error.message` joins them one per line as `file#pointer: message`:

```
ci/fragment.json#/parameters/minutes: parameter "minutes" has no value and no default
```

A file that cannot be read is reported against the file that extends it, at `/extends`. A cycle is reported against the file that closes it, with the whole chain in the message.

## Validating the result

Validate `value` with whatever schema library you use, then map each issue path back through `originOf`:

```ts
const result = schema.safeParse(composed.value);
if (!result.success) {
  for (const issue of result.error.issues) {
    const pointer = issue.path.map((segment) => `/${String(segment)}`).join("");
    console.error(composed.originOf(pointer), issue.message);
  }
}
```

Escape `~` as `~0` and `/` as `~1` in segments if your keys can contain them.

## Development

Node 22 or later, pnpm. ESM only.

| Script | |
| --- | --- |
| `pnpm lint` / `pnpm lint:check` | ESLint, fixing / check only |
| `pnpm typecheck` | `tsc` |
| `pnpm test` | Vitest, tests colocated as `*.unit.test.ts` |
| `pnpm build` | tsdown into `dist` |

Commits follow Conventional Commits and are checked by commitlint. Releases are cut by semantic-release from `main` in CI, published to npm with provenance.

`CLAUDE.md` and `AGENTS.md` are symlinks to this file.
