import { describe, expect, it } from "vitest";

import { composeJson, CompositionError, resolveRelative, type FileReader } from "./index";

const INHERITED_TIMEOUT = 5;
const SUPPLIED_MINUTES = 7;

function memory(files: Record<string, unknown>): FileReader {
  return {
    async read(path) {
      const content = files[path];
      if (content === undefined) return Promise.reject(new Error(`no such file ${path}`));

      return Promise.resolve(typeof content === "string" ? content : JSON.stringify(content));
    },
  };
}

async function failure(promise: Readonly<Promise<unknown>>): Promise<CompositionError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CompositionError) return error;
    throw error;
  }
  throw new Error("the composition succeeded");
}

const lintJob = { name: "Lint", steps: [{ run: "lint" }] };
const base = {
  name: "CI",
  triggers: [{ kind: "push" }],
  env: { A: "base", B: "base" },
  jobs: { lint: lintJob },
};

describe("composeJson composition", () => {
  it("returns a document with no header unchanged and lists its file", async () => {
    const composed = await composeJson("main.json", memory({ "main.json": base }));
    expect(composed.value).toEqual(base);
    expect(composed.files).toEqual(["main.json"]);
  });

  it("deep-merges objects with the extending file winning", async () => {
    const { value } = await composeJson(
      "ci/main.json",
      memory({
        "ci/main.json": {
          extends: "./base.json",
          env: { B: "child", C: "child" },
          jobs: { lint: { timeoutMinutes: INHERITED_TIMEOUT } },
        },
        "ci/base.json": base,
      }),
    );
    expect(value).toEqual({
      ...base,
      env: { A: "base", B: "child", C: "child" },
      jobs: { lint: { ...lintJob, timeoutMinutes: INHERITED_TIMEOUT } },
    });
  });

  it("merges parents in order and applies the own body last", async () => {
    const { value, files } = await composeJson(
      "main.json",
      memory({
        "main.json": { extends: ["./a.json", "./b.json"], own: "main" },
        "a.json": { a: "a", shared: "a", own: "a" },
        "b.json": { b: "b", shared: "b", own: "b" },
      }),
    );
    expect(value).toEqual({ a: "a", b: "b", shared: "b", own: "main" });
    expect(files).toEqual(["main.json", "a.json", "b.json"]);
  });

  it("resolves extends relative to the extending file", async () => {
    const { value } = await composeJson(
      "ci/pipelines/main.json",
      memory({
        "ci/pipelines/main.json": { extends: "../shared/base.json", x: 1 },
        "ci/shared/base.json": { extends: "./deeper.json", y: 2 },
        "ci/shared/deeper.json": { z: 3 },
      }),
    );
    expect(value).toEqual({ x: 1, y: 2, z: 3 });
  });

  it("replaces arrays by default", async () => {
    const { value } = await composeJson(
      "main.json",
      memory({
        "main.json": { extends: "./base.json", steps: [{ run: "extra" }] },
        "base.json": { steps: [{ run: "lint" }] },
      }),
    );
    expect(value).toEqual({ steps: [{ run: "extra" }] });
  });

  it.each([
    ["a set", new Set(["steps"])],
    ["an array", ["steps"]],
  ])("concatenates arrays under a configured key, given %s", async (_label, concatenate) => {
    const { value } = await composeJson(
      "main.json",
      memory({
        "main.json": {
          extends: "./base.json",
          triggers: [{ kind: "manual" }],
          jobs: { lint: { steps: [{ run: "extra" }] } },
        },
        "base.json": base,
      }),
      { concatenate },
    );
    expect(value).toMatchObject({
      triggers: [{ kind: "manual" }],
      jobs: { lint: { steps: [{ run: "lint" }, { run: "extra" }] } },
    });
  });

  it("replaces an inherited value outright with a $replace wrapper", async () => {
    const { value } = await composeJson(
      "main.json",
      memory({
        "main.json": {
          extends: "./base.json",
          jobs: { lint: { steps: { $replace: [{ run: "only" }] } } },
        },
        "base.json": base,
      }),
      { concatenate: ["steps"] },
    );
    expect(value).toMatchObject({ jobs: { lint: { steps: [{ run: "only" }] } } });
  });

  it("replaces an inherited object outright with a $replace wrapper", async () => {
    const { value } = await composeJson(
      "main.json",
      memory({
        "main.json": { extends: "./base.json", env: { $replace: { ONLY: "this" } } },
        "base.json": base,
      }),
    );
    expect(value).toMatchObject({ env: { ONLY: "this" } });
  });

  it("unwraps a $replace marker that has nothing to replace", async () => {
    const { value, originOf } = await composeJson(
      "main.json",
      memory({ "main.json": { list: { $replace: [1, 2] }, nested: { $replace: { $replace: "x" } } } }),
    );
    expect(value).toEqual({ list: [1, 2], nested: "x" });
    expect(originOf("/list/1")).toEqual({ file: "main.json", pointer: "/list/$replace/1" });
  });

  it("substitutes typed parameters supplied by the extending file, else defaults", async () => {
    const { value } = await composeJson(
      "ci/main.json",
      memory({
        "ci/main.json": {
          name: "CI",
          extends: { path: "./fragment.json", with: { minutes: SUPPLIED_MINUTES } },
        },
        "ci/fragment.json": {
          parameters: {
            runner: { type: "string", default: "ubuntu-latest", description: "where it runs" },
            minutes: { type: "number" },
            verbose: { type: "boolean", default: false },
          },
          job: {
            runsOn: [{ $param: "runner" }],
            timeoutMinutes: { $param: "minutes" },
            verbose: { $param: "verbose" },
          },
        },
      }),
    );
    expect(value).toEqual({
      name: "CI",
      job: { runsOn: ["ubuntu-latest"], timeoutMinutes: SUPPLIED_MINUTES, verbose: false },
    });
  });

  it("reports a supplied parameter at the file that extends onwards without declaring it", async () => {
    const error = await failure(
      composeJson(
        "main.json",
        memory({
          "main.json": { extends: { path: "./mid.json", with: { n: 1 } } },
          "mid.json": { extends: "./leaf.json" },
          "leaf.json": { parameters: { n: { type: "number" } } },
        }),
      ),
    );
    expect(error.issues[0]).toMatchObject({
      file: "mid.json",
      pointer: "/parameters",
    });
  });
});

describe("composeJson origins", () => {
  const files = {
    "ci/main.json": {
      extends: "./base.json",
      env: { B: "child" },
      jobs: { lint: { timeoutMinutes: 5 } },
    },
    "ci/base.json": { env: { A: "base", B: "base" }, jobs: { lint: { name: "Lint" } }, tags: ["x"] },
  };

  it("reports where each node was authored, across extends", async () => {
    const { originOf } = await composeJson("ci/main.json", memory(files));
    expect(originOf("/env/A")).toEqual({ file: "ci/base.json", pointer: "/env/A" });
    expect(originOf("/env/B")).toEqual({ file: "ci/main.json", pointer: "/env/B" });
    expect(originOf("/jobs/lint/name")).toEqual({ file: "ci/base.json", pointer: "/jobs/lint/name" });
    expect(originOf("/jobs/lint/timeoutMinutes")).toEqual({
      file: "ci/main.json",
      pointer: "/jobs/lint/timeoutMinutes",
    });
    expect(originOf("/tags/0")).toEqual({ file: "ci/base.json", pointer: "/tags/0" });
  });

  it("falls back to the nearest defined origin for a pointer outside the value", async () => {
    const { originOf } = await composeJson("ci/main.json", memory(files));
    expect(originOf("/env/MISSING")).toEqual(originOf("/env"));
    expect(originOf("/tags/9")).toEqual({ file: "ci/base.json", pointer: "/tags" });
    expect(originOf("/env/A/deeper")).toEqual({ file: "ci/base.json", pointer: "/env/A" });
    expect(originOf("")).toEqual({ file: "ci/main.json", pointer: "" });
  });

  it("unescapes pointer segments", async () => {
    const { originOf } = await composeJson(
      "main.json",
      memory({ "main.json": { "a/b": { "c~d": 1 } } }),
    );
    expect(originOf("/a~1b/c~0d")).toEqual({ file: "main.json", pointer: "/a~1b/c~0d" });
  });

  it("rejects a string that is not a pointer", async () => {
    const { originOf } = await composeJson("main.json", memory({ "main.json": {} }));
    expect(() => originOf("env")).toThrow(RangeError);
  });

  it("locates a substituted parameter at the node that referenced it", async () => {
    const { originOf } = await composeJson(
      "main.json",
      memory({
        "main.json": { extends: { path: "./f.json", with: { n: 1 } } },
        "f.json": { parameters: { n: { type: "number" } }, value: { $param: "n" } },
      }),
    );
    expect(originOf("/value")).toEqual({ file: "f.json", pointer: "/value" });
  });
});

describe("composeJson onDocument", () => {
  it("is called for the entry and every fragment with the document as authored", async () => {
    const seen: [string, unknown][] = [];
    await composeJson(
      "main.json",
      memory({
        "main.json": { extends: "./base.json", own: true },
        "base.json": { inherited: true },
      }),
      {
        onDocument(json, file) {
          seen.push([file, json]);

          return [];
        },
      },
    );
    expect(seen).toEqual([
      ["main.json", { extends: "./base.json", own: true }],
      ["base.json", { inherited: true }],
    ]);
  });

  it("raises its issues as a CompositionError located in the fragment", async () => {
    const error = await failure(
      composeJson(
        "main.json",
        memory({
          "main.json": { $schema: "x", extends: "./base.json" },
          "base.json": { name: "no schema" },
        }),
        {
          onDocument: (json, file) =>
            typeof json["$schema"] === "string"
              ? []
              : [{ message: "must declare $schema", file, pointer: "/$schema" }],
        },
      ),
    );
    expect(error.issues).toEqual([
      { message: "must declare $schema", file: "base.json", pointer: "/$schema" },
    ]);
    expect(error.message).toBe("base.json#/$schema: must declare $schema");
  });
});

describe("composeJson errors", () => {
  it("names the parameter's declaring file and pointer when it has no value", async () => {
    const error = await failure(
      composeJson(
        "ci/main.json",
        memory({
          "ci/main.json": { extends: "./fragment.json" },
          "ci/fragment.json": { parameters: { minutes: { type: "number" } } },
        }),
      ),
    );
    expect(error.issues).toEqual([
      {
        message: 'parameter "minutes" has no value and no default',
        file: "ci/fragment.json",
        pointer: "/parameters/minutes",
      },
    ]);
  });

  it("rejects a parameter of the wrong type", async () => {
    const error = await failure(
      composeJson(
        "ci/main.json",
        memory({
          "ci/main.json": { extends: { path: "./fragment.json", with: { minutes: "seven" } } },
          "ci/fragment.json": { parameters: { minutes: { type: "number" } } },
        }),
      ),
    );
    expect(error.message).toBe(
      'ci/fragment.json#/parameters/minutes: parameter "minutes" must be a number',
    );
  });

  it("rejects a default of the wrong type", async () => {
    const error = await failure(
      composeJson(
        "main.json",
        memory({ "main.json": { parameters: { n: { type: "number", default: "x" } } } }),
      ),
    );
    expect(error.issues[0]).toMatchObject({ pointer: "/parameters/n" });
    expect(error.message).toContain("must be a number");
  });

  it("rejects a parameter the file does not declare", async () => {
    const error = await failure(
      composeJson(
        "main.json",
        memory({
          "main.json": { extends: { path: "./f.json", with: { stray: 1 } } },
          "f.json": {},
        }),
      ),
    );
    expect(error.issues[0]).toMatchObject({ file: "f.json", pointer: "/parameters" });
    expect(error.message).toContain('"stray"');
  });

  it("rejects a $param that names an undeclared parameter, at the name", async () => {
    const error = await failure(
      composeJson("main.json", memory({ "main.json": { value: { $param: "ghost" } } })),
    );
    expect(error.issues[0]).toMatchObject({ file: "main.json", pointer: "/value/$param" });
  });

  it("names the fragment file and pointer for a parameter error that came through extends", async () => {
    const error = await failure(
      composeJson(
        "a/main.json",
        memory({
          "a/main.json": { extends: "./mid.json" },
          "a/mid.json": { extends: "./leaf.json" },
          "a/leaf.json": { x: { $param: "nope" } },
        }),
      ),
    );
    expect(error.issues[0]).toMatchObject({ file: "a/leaf.json", pointer: "/x/$param" });
  });

  it("reports an extends cycle with the chain, at the file that closes it", async () => {
    const error = await failure(
      composeJson(
        "a.json",
        memory({
          "a.json": { extends: "./b.json" },
          "b.json": { extends: "./a.json" },
        }),
      ),
    );
    expect(error.issues).toEqual([
      {
        message: "extends forms a cycle: a.json -> b.json -> a.json",
        file: "b.json",
        pointer: "/extends",
      },
    ]);
  });

  it("reports an unreadable extends target from the extending file", async () => {
    const error = await failure(
      composeJson("main.json", memory({ "main.json": { extends: "./missing.json" } })),
    );
    expect(error.issues[0]).toMatchObject({ file: "main.json", pointer: "/extends" });
    expect(error.issues[0]?.message).toContain("cannot read file: no such file missing.json");
  });

  it("reports malformed JSON with the file", async () => {
    const error = await failure(composeJson("main.json", memory({ "main.json": "{ not json" })));
    expect(error.issues[0]?.file).toBe("main.json");
    expect(error.issues[0]?.pointer).toBe("");
    expect(error.issues[0]?.message).toContain("invalid JSON");
  });

  it.each([["[1]"], ['"text"'], ["null"], ["3"]])(
    "rejects a document that is not an object: %s",
    async (text) => {
      const error = await failure(composeJson("main.json", memory({ "main.json": text })));
      expect(error.issues).toEqual([
        { message: "a document must be a JSON object", file: "main.json", pointer: "" },
      ]);
    },
  );

  it.each([
    ["extends is a number", { extends: 3 }, "/extends"],
    ["an extends entry is empty", { extends: [""] }, "/extends/0"],
    ["an extends object has no path", { extends: [{ with: {} }] }, "/extends/0/path"],
    ["an extends object has an unknown key", { extends: { path: "./x", more: 1 } }, "/extends/more"],
    ["with holds a non-scalar", { extends: { path: "./x", with: { n: [] } } }, "/extends/with/n"],
    ["parameters is an array", { parameters: [] }, "/parameters"],
    ["a declaration has no type", { parameters: { n: {} } }, "/parameters/n/type"],
    ["a declaration has an unknown type", { parameters: { n: { type: "date" } } }, "/parameters/n/type"],
    ["a declaration is not an object", { parameters: { n: "string" } }, "/parameters/n"],
    ["a default is not a scalar", { parameters: { n: { type: "string", default: [] } } }, "/parameters/n/default"],
    ["a description is not a string", { parameters: { n: { type: "string", description: 1 } } }, "/parameters/n/description"],
    ["with is not an object", { extends: { path: "./x", with: "n" } }, "/extends/with"],
    ["an extends entry is a number inside an array", { extends: [1] }, "/extends/0"],
    ["a declaration has an unknown key", { parameters: { n: { type: "string", x: 1 } } }, "/parameters/n/x"],
  ])("rejects a malformed header when %s", async (_label, document, pointer) => {
    const error = await failure(composeJson("main.json", memory({ "main.json": document })));
    expect(error.issues.map((issue) => issue.pointer)).toContain(pointer);
    expect(error.issues.every((issue) => issue.file === "main.json")).toBe(true);
  });
});

describe("composeJson prototype safety", () => {
  it("keeps a __proto__ key as an ordinary own property", async () => {
    const { value, originOf } = await composeJson(
      "main.json",
      memory({ "main.json": '{"__proto__": {"polluted": true}, "other": 1}' }),
    );
    expect(Object.getOwnPropertyDescriptor(value, "__proto__")?.value).toEqual({ polluted: true });
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(originOf("/__proto__/polluted")).toEqual({
      file: "main.json",
      pointer: "/__proto__/polluted",
    });
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });

  it("merges a __proto__ key across extends without touching Object.prototype", async () => {
    const { value } = await composeJson(
      "main.json",
      memory({
        "main.json": '{"extends": "./base.json", "__proto__": {"b": 2}}',
        "base.json": '{"__proto__": {"a": 1}}',
      }),
    );
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.entries(Object.getOwnPropertyDescriptors(value))).toHaveLength(1);
    expect(Object.getOwnPropertyDescriptor(value, "__proto__")?.value).toEqual({ a: 1, b: 2 });
    expect(Object.hasOwn(Object.prototype, "a")).toBe(false);
  });

  it("treats a parameter named __proto__ or constructor as an ordinary name", async () => {
    const { value } = await composeJson(
      "main.json",
      memory({
        "main.json": '{"parameters": {"constructor": {"type": "string", "default": "c"}}, "v": {"$param": "constructor"}}',
      }),
    );
    expect(value).toEqual({ v: "c" });
    const error = await failure(
      composeJson("main.json", memory({ "main.json": { v: { $param: "constructor" } } })),
    );
    expect(error.issues[0]?.message).toContain("does not declare");
  });
});

describe("resolveRelative", () => {
  it.each([
    ["a/b/main.json", "./c.json", "a/b/c.json"],
    ["a/b/main.json", "../c.json", "a/c.json"],
    ["main.json", "x/y.json", "x/y.json"],
    ["a/b/main.json", "./././c.json", "a/b/c.json"],
  ])("resolves %s + %s", (from, relative, expected) => {
    expect(resolveRelative(from, relative)).toBe(expected);
  });
});
