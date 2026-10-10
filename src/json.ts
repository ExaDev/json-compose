/** A parsed JSON value. Objects are read-only records; a `__proto__` key is an ordinary own property. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** A string, number or boolean: the values a parameter may take. */
export type Scalar = string | number | boolean;

export function isJsonArray(value: unknown): value is readonly JsonValue[] {
  return Array.isArray(value);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isScalar(value: unknown): value is Scalar {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * Narrows the output of `JSON.parse`, which is typed `any`. Anything `JSON.parse` returns satisfies it, so a `false` result would mean the parser contract was broken.
 */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || isScalar(value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") return Object.values(value).every(isJsonValue);

  return false;
}
