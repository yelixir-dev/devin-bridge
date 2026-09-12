type SchemaObject = { readonly [key: string]: unknown };
type SchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isObject(value: unknown): value is SchemaObject {
  return typeof value === "object" && value !== null && !isArray(value);
}

function isSchemaType(value: unknown): value is SchemaType {
  return value === "object" || value === "array" || value === "string"
    || value === "number" || value === "integer" || value === "boolean" || value === "null";
}

function matchesType(value: unknown, type: SchemaType): boolean {
  switch (type) {
    case "object": return isObject(value);
    case "array": return isArray(value);
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (isArray(left) && isArray(right)) {
    return left.length === right.length
      && left.every((entry, index) => structurallyEqual(entry, right[index]));
  }
  if (isObject(left) && isObject(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length
      && keys.every(key => Object.hasOwn(right, key) && structurallyEqual(left[key], right[key]));
  }
  return false;
}

export function conformsToSchema(value: unknown, schema: unknown): boolean {
  if (schema === false) return false;
  if (!isObject(schema)) return true;
  if (schema.nullable === true && value === null) return true;
  if (typeof value === "number" && !Number.isFinite(value)) return false;

  if (isSchemaType(schema.type) && !matchesType(value, schema.type)) return false;
  if (isArray(schema.type)
    && !schema.type.some(type => !isSchemaType(type) || matchesType(value, type))) return false;
  if (isArray(schema.enum) && !schema.enum.some(entry => structurallyEqual(value, entry))) return false;
  if (Object.hasOwn(schema, "const") && !structurallyEqual(value, schema.const)) return false;

  if (isArray(schema.anyOf) && !schema.anyOf.some(branch => conformsToSchema(value, branch))) return false;
  if (isArray(schema.oneOf)
    && schema.oneOf.filter(branch => conformsToSchema(value, branch)).length !== 1) return false;
  if (isArray(schema.allOf) && !schema.allOf.every(branch => conformsToSchema(value, branch))) return false;

  if (isObject(value)) {
    if (isArray(schema.required)
      && schema.required.some(key => typeof key === "string" && !Object.hasOwn(value, key))) return false;
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(properties, key)) {
        if (!conformsToSchema(value[key], properties[key])) return false;
      } else {
        if (schema.additionalProperties === false) return false;
        if (isObject(schema.additionalProperties)
          && !conformsToSchema(value[key], schema.additionalProperties)) return false;
      }
    }
  }

  if (isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    // Tuple schemas are unsupported; only a single schema applies to every item.
    if (!isArray(schema.items) && !value.every(item => conformsToSchema(item, schema.items))) return false;
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false;
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
  }

  return true;
}
