import { expect, test } from "bun:test";
import { conformsToSchema } from "../src/tool-schema.ts";

type SchemaCase = {
  readonly name: string;
  readonly schema: unknown;
  readonly accepted: readonly unknown[];
  readonly rejected: readonly unknown[];
};

const cases: readonly SchemaCase[] = [
  { name: "object type excludes arrays and null", schema: { type: "object" }, accepted: [{}, { a: 1 }], rejected: [[], null, "object"] },
  { name: "array type excludes objects", schema: { type: "array" }, accepted: [[], [1]], rejected: [{}, null, "array"] },
  { name: "string type", schema: { type: "string" }, accepted: ["", "hello"], rejected: [1, null, true] },
  { name: "number type accepts finite integers and fractions", schema: { type: "number" }, accepted: [0, -2, 1.5], rejected: ["1", NaN, Infinity, -Infinity] },
  { name: "integer type rejects fractions and nonfinite numbers", schema: { type: "integer" }, accepted: [0, -2, 3], rejected: [1.5, "3", NaN, Infinity, -Infinity] },
  { name: "boolean type", schema: { type: "boolean" }, accepted: [true, false], rejected: [0, "true", null] },
  { name: "null type", schema: { type: "null" }, accepted: [null], rejected: [undefined, false, {}, []] },
  { name: "type union accepts any listed type", schema: { type: ["string", "number", "null"] }, accepted: ["a", 2.5, null], rejected: [false, [], {}] },
  { name: "enum distinguishes string and number", schema: { enum: ["ready", 2] }, accepted: ["ready", 2], rejected: ["2", 3, null] },
  {
    name: "enum compares nested objects and arrays structurally",
    schema: { enum: [{ a: [1, { b: true }], c: null }] },
    accepted: [{ c: null, a: [1, { b: true }] }],
    rejected: [{ a: [1, { b: false }], c: null }, { a: [1, { b: true }], c: null, extra: 1 }, { a: [1], c: null }],
  },
  { name: "const compares scalar values without coercion", schema: { const: 4 }, accepted: [4], rejected: ["4", 5, null] },
  { name: "const preserves null", schema: { const: null }, accepted: [null], rejected: [undefined, false, {}] },
  { name: "const compares array order and length", schema: { const: [1, { a: 2 }] }, accepted: [[1, { a: 2 }]], rejected: [[{ a: 2 }, 1], [1], [1, { a: 2 }, 3], { 0: 1, 1: { a: 2 } }] },
  { name: "properties validates present values recursively without requiring them", schema: { properties: { count: { type: "integer" } } }, accepted: [{}, { count: 2 }, { other: true }], rejected: [{ count: "2" }, { count: 2.5 }] },
  { name: "required checks presence rather than truthiness", schema: { required: ["enabled"] }, accepted: [{ enabled: false }, { enabled: null }, { enabled: undefined }], rejected: [{}, { other: true }] },
  { name: "additionalProperties false rejects unknown keys", schema: { properties: { count: { type: "number" } }, additionalProperties: false }, accepted: [{}, { count: 1 }], rejected: [{ extra: 1 }, { count: 1, extra: 2 }, { toString: 1 }] },
  { name: "additionalProperties false without properties allows only an empty object", schema: { additionalProperties: false }, accepted: [{}], rejected: [{ a: 1 }] },
  { name: "additionalProperties schema validates only extra values", schema: { properties: { name: { type: "string" } }, additionalProperties: { type: "integer" } }, accepted: [{ name: "tool", count: 1 }, {}], rejected: [{ name: "tool", count: "1" }, { name: 1 }] },
  { name: "items applies a single schema to every element", schema: { items: { type: "string" } }, accepted: [[], ["a", "b"]], rejected: [["a", 1], [null]] },
  { name: "items accepts a false schema only for empty arrays", schema: { items: false }, accepted: [[]], rejected: [[1]] },
  { name: "minItems includes its boundary", schema: { minItems: 2 }, accepted: [[1, 2], [1, 2, 3]], rejected: [[], [1]] },
  { name: "maxItems includes its boundary", schema: { maxItems: 2 }, accepted: [[], [1, 2]], rejected: [[1, 2, 3]] },
  { name: "minLength includes its boundary using string length", schema: { minLength: 2 }, accepted: ["ab", "abc", "\uD83D\uDE00"], rejected: ["", "a"] },
  { name: "maxLength includes its boundary using string length", schema: { maxLength: 2 }, accepted: ["", "ab", "\uD83D\uDE00"], rejected: ["abc"] },
  { name: "minimum includes its boundary", schema: { minimum: 2 }, accepted: [2, 2.5], rejected: [1.5, -1] },
  { name: "maximum includes its boundary", schema: { maximum: 2 }, accepted: [2, -1], rejected: [2.5, 3] },
  { name: "anyOf permits one or multiple matching branches", schema: { anyOf: [{ type: "number" }, { type: "integer" }, { const: "ok" }] }, accepted: [1, 1.5, "ok"], rejected: [false, "bad"] },
  { name: "oneOf requires exactly one matching branch", schema: { oneOf: [{ type: "number" }, { type: "integer" }, { const: "ok" }] }, accepted: [1.5, "ok"], rejected: [1, false, "bad"] },
  { name: "allOf requires every branch", schema: { allOf: [{ type: "number" }, { minimum: 2 }, { maximum: 4 }] }, accepted: [2, 3, 4], rejected: [1, 5, "3"] },
  { name: "nullable true permits null but still validates other values", schema: { type: "string", minLength: 2, nullable: true }, accepted: [null, "ok"], rejected: [1, "a"] },
  { name: "nullable false does not permit null", schema: { type: "string", nullable: false }, accepted: ["ok"], rejected: [null] },
  {
    name: "nested object and array constraints compose",
    schema: {
      type: "object", required: ["rows"], additionalProperties: false,
      properties: {
        rows: {
          type: "array", minItems: 1,
          items: { type: "object", required: ["id"], properties: { id: { type: "integer" } }, additionalProperties: false },
        },
      },
    },
    accepted: [{ rows: [{ id: 1 }, { id: 2 }] }],
    rejected: [{}, { rows: [] }, { rows: [{}] }, { rows: [{ id: "1" }] }, { rows: [{ id: 1, extra: true }] }, { rows: [{ id: 1 }], extra: true }],
  },
];

test.each([...cases])("$name", ({ schema, accepted, rejected }) => {
  // Given a schema and values on either side of its constraints.
  // When each value is checked, then only conforming values are accepted.
  for (const value of accepted) expect(conformsToSchema(value, schema)).toBe(true);
  for (const value of rejected) expect(conformsToSchema(value, schema)).toBe(false);
});

test.each([undefined, null, true, 1, "schema", []].map(schema => ({ schema })))("non-object schema %j is unrestricted", ({ schema }) => {
  // Given a value and a non-object schema other than false.
  const value = { arguments: [1, null] };
  // When checked, then the unsupported schema is ignored.
  expect(conformsToSchema(value, schema)).toBe(true);
});

test("false schema rejects every value", () => {
  // Given the boolean false schema.
  const values: readonly unknown[] = [undefined, null, false, 0, "", [], {}];
  // When checked, then no value conforms.
  for (const value of values) expect(conformsToSchema(value, false)).toBe(false);
});

test("unknown keywords do not constrain values or hide implemented violations", () => {
  // Given unsupported reference, format, pattern, and conditional constraints.
  const schema = { $ref: "#/$defs/missing", format: "email", pattern: "^required$", not: {}, if: {}, then: false };
  // When checked, then only implemented constraints affect the result.
  expect(conformsToSchema("not an email", schema)).toBe(true);
  expect(conformsToSchema(42, { ...schema, type: "string" })).toBe(false);
});

test.each([null, [], true, "invalid", 42].map(properties => ({ properties })))("non-object properties map %j is ignored safely", ({ properties }) => {
  // Given an unsupported properties map.
  // When checked, then it acts as an empty map and extra-key policy still applies.
  expect(conformsToSchema({ a: 1 }, { properties })).toBe(true);
  expect(conformsToSchema({ a: 1 }, { properties, additionalProperties: false })).toBe(false);
  expect(conformsToSchema({ a: "bad" }, { properties, additionalProperties: { type: "number" } })).toBe(false);
});

test("required names must be own properties", () => {
  // Given a required name inherited from Object.prototype.
  const schema = { required: ["toString"] };
  // When checked, then inherited presence does not fulfill required.
  expect(conformsToSchema({}, schema)).toBe(false);
  expect(conformsToSchema({ toString: null }, schema)).toBe(true);
});

test("deep equality checks property names and own properties", () => {
  // Given equally sized objects with different keys, including a prototype name.
  // When checked, then neither object is equal to the constant.
  expect(conformsToSchema({ b: 1 }, { const: { a: 1 } })).toBe(false);
  expect(conformsToSchema({ other: undefined }, { const: { toString: undefined } })).toBe(false);
});

test("constraints apply only to their corresponding value types", () => {
  // Given type-specific constraints without a type restriction.
  const schema = { properties: { a: false }, required: ["a"], additionalProperties: false, items: false, minItems: 2, maxItems: 0, minLength: 2, maxLength: 0, minimum: 2, maximum: 0 };
  // When checking unrelated types, then the constraints do not reject them.
  expect(conformsToSchema(true, schema)).toBe(true);
  expect(conformsToSchema(null, schema)).toBe(true);
});

test("unsupported keyword forms fail open", () => {
  // Given malformed or unsupported forms of recognized keywords.
  const schema = { type: "future-type", enum: {}, required: true, properties: null, additionalProperties: true, items: [{ type: "string" }], anyOf: {}, oneOf: null, allOf: false, minItems: "10" };
  // When checked, then no unsupported form imposes a constraint.
  expect(conformsToSchema([1, 2], schema)).toBe(true);
  expect(conformsToSchema({ extra: true }, schema)).toBe(true);
  expect(conformsToSchema(false, { type: ["string", "future-type"] })).toBe(true);
});

test("empty enum and combinator arrays retain their logical semantics", () => {
  // Given constraints containing no candidates or branches.
  // When checked, then disjunctions reject and an empty conjunction accepts.
  expect(conformsToSchema(1, { enum: [] })).toBe(false);
  expect(conformsToSchema(1, { anyOf: [] })).toBe(false);
  expect(conformsToSchema(1, { oneOf: [] })).toBe(false);
  expect(conformsToSchema(1, { allOf: [] })).toBe(true);
});

test("boolean schemas work recursively in properties and combinators", () => {
  // Given true and false subschemas.
  // When checked, then false rejects and true accepts in every implemented recursive position.
  expect(conformsToSchema({}, { properties: { forbidden: false } })).toBe(true);
  expect(conformsToSchema({ forbidden: 1 }, { properties: { forbidden: false } })).toBe(false);
  expect(conformsToSchema(1, { anyOf: [false, true] })).toBe(true);
  expect(conformsToSchema(1, { oneOf: [true, true] })).toBe(false);
  expect(conformsToSchema(1, { allOf: [true, false] })).toBe(false);
});

test("nullable is an explicit null allowance even with other constraints", () => {
  // Given null excluded by enum and combinators but explicitly allowed by nullable.
  const schema = { nullable: true, enum: ["ok"], allOf: [{ type: "string" }] };
  // When checked, then null is accepted but a merely truthy nullable is ignored.
  expect(conformsToSchema(null, schema)).toBe(true);
  expect(conformsToSchema(null, { type: "string", nullable: "true" })).toBe(false);
});
