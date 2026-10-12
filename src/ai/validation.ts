// Port of earendil-works/pi v0.87.1 packages/ai/src/utils/validation.ts (MIT)
// onto zod. Same observable contract as pi's typebox validator: clone the
// arguments, drop null values of optional properties, coerce primitives toward
// the schema types (string "5" → 5, boolean 1 → true, …), then validate and
// throw a formatted multi-error message on failure.

import { z } from "zod";
import type { Tool, ToolCall } from "./types.ts";

const validatorCache = new WeakMap<object, z.ZodType>();

function getValidator(schema: z.ZodType): z.ZodType {
	const cached = validatorCache.get(schema as unknown as object);
	if (cached) return cached;
	validatorCache.set(schema as unknown as object, schema);
	return schema;
}

interface JsonSchemaObject {
	type?: string | string[];
	properties?: Record<string, JsonSchemaObject>;
	required?: string[];
	items?: JsonSchemaObject | JsonSchemaObject[];
	additionalProperties?: boolean | JsonSchemaObject;
	anyOf?: JsonSchemaObject[];
	oneOf?: JsonSchemaObject[];
	allOf?: JsonSchemaObject[];
}

function schemaOf(schema: z.ZodType): JsonSchemaObject {
	try {
		return z.toJSONSchema(schema) as JsonSchemaObject;
	} catch {
		return {};
	}
}

function getSchemaTypes(schema: JsonSchemaObject): string[] {
	if (typeof schema.type === "string") return [schema.type];
	if (Array.isArray(schema.type)) return schema.type.filter((type): type is string => typeof type === "string");
	return [];
}

function matchesJsonType(value: unknown, type: string): boolean {
	switch (type) {
		case "number":
			return typeof value === "number";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "string":
			return typeof value === "string";
		case "null":
			return value === null;
		case "array":
			return Array.isArray(value);
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value);
		default:
			return false;
	}
}

function coercePrimitiveByType(value: unknown, type: string): unknown {
	switch (type) {
		case "number": {
			if (value === null) return 0;
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = Number(value);
				if (Number.isFinite(parsed)) return parsed;
			}
			if (typeof value === "boolean") return value ? 1 : 0;
			return value;
		}
		case "integer": {
			if (value === null) return 0;
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = Number(value);
				if (Number.isInteger(parsed)) return parsed;
			}
			if (typeof value === "boolean") return value ? 1 : 0;
			return value;
		}
		case "boolean": {
			if (value === null) return false;
			if (typeof value === "string") {
				if (value === "true") return true;
				if (value === "false") return false;
			}
			if (typeof value === "number") {
				if (value === 1) return true;
				if (value === 0) return false;
			}
			return value;
		}
		case "string": {
			if (value === null) return "";
			if (typeof value === "number" || typeof value === "boolean") return String(value);
			return value;
		}
		case "null": {
			if (value === "" || value === 0 || value === false) return null;
			return value;
		}
		default:
			return value;
	}
}

function applySchemaObjectCoercion(value: Record<string, unknown>, schema: JsonSchemaObject): void {
	const properties = schema.properties;
	const definedKeys = new Set<string>(properties ? Object.keys(properties) : []);

	if (properties) {
		for (const [key, propertySchema] of Object.entries(properties)) {
			if (!(key in value)) continue;
			value[key] = coerceWithJsonSchema(value[key], propertySchema);
		}
	}

	if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
		for (const [key, propertyValue] of Object.entries(value)) {
			if (definedKeys.has(key)) continue;
			value[key] = coerceWithJsonSchema(propertyValue, schema.additionalProperties);
		}
	}
}

function applySchemaArrayCoercion(value: unknown[], schema: JsonSchemaObject): void {
	if (Array.isArray(schema.items)) {
		for (let index = 0; index < value.length; index++) {
			const itemSchema = schema.items[index];
			if (!itemSchema) continue;
			value[index] = coerceWithJsonSchema(value[index], itemSchema);
		}
		return;
	}

	if (schema.items && typeof schema.items === "object") {
		for (let index = 0; index < value.length; index++) {
			value[index] = coerceWithJsonSchema(value[index], schema.items);
		}
	}
}

function getSubSchemaTypes(schema: JsonSchemaObject): string[] {
	return getSchemaTypes(schema);
}

function coerceWithUnionSchema(value: unknown, schemas: JsonSchemaObject[]): unknown {
	for (const schema of schemas) {
		const types = getSubSchemaTypes(schema);
		if (types.length > 0 && types.some((schemaType) => matchesJsonType(value, schemaType))) return value;
	}
	for (const schema of schemas) {
		const candidate = structuredClone(value);
		const coerced = coerceWithJsonSchema(candidate, schema);
		const types = getSubSchemaTypes(schema);
		if (types.length > 0 && types.some((schemaType) => matchesJsonType(coerced, schemaType))) return coerced;
	}
	return value;
}

function coerceWithJsonSchema(value: unknown, schema: JsonSchemaObject): unknown {
	let nextValue = value;

	if (Array.isArray(schema.allOf)) {
		for (const nested of schema.allOf) {
			nextValue = coerceWithJsonSchema(nextValue, nested);
		}
	}

	if (Array.isArray(schema.anyOf)) {
		nextValue = coerceWithUnionSchema(nextValue, schema.anyOf);
	}

	if (Array.isArray(schema.oneOf)) {
		nextValue = coerceWithUnionSchema(nextValue, schema.oneOf);
	}

	const schemaTypes = getSchemaTypes(schema);
	const matchesUnionMember =
		schemaTypes.length > 1 && schemaTypes.some((schemaType) => matchesJsonType(nextValue, schemaType));
	if (schemaTypes.length > 0 && !matchesUnionMember) {
		for (const schemaType of schemaTypes) {
			const candidate = coercePrimitiveByType(nextValue, schemaType);
			if (candidate !== nextValue) {
				nextValue = candidate;
				break;
			}
		}
	}

	if (
		schemaTypes.includes("object") &&
		typeof nextValue === "object" &&
		nextValue !== null &&
		!Array.isArray(nextValue)
	) {
		applySchemaObjectCoercion(nextValue as Record<string, unknown>, schema);
	}

	if (schemaTypes.includes("array") && Array.isArray(nextValue)) {
		applySchemaArrayCoercion(nextValue, schema);
	}

	return nextValue;
}

function normalizeOptionalNulls(value: unknown, schema: JsonSchemaObject): void {
	if (Array.isArray(value)) {
		if (Array.isArray(schema.items)) {
			for (let index = 0; index < value.length; index++) {
				const itemSchema = schema.items[index];
				if (itemSchema) normalizeOptionalNulls(value[index], itemSchema);
			}
		} else if (schema.items) {
			for (const item of value) normalizeOptionalNulls(item, schema.items);
		}
		return;
	}
	if (typeof value !== "object" || value === null || !schema.properties) return;

	const object = value as Record<string, unknown>;
	const required = new Set(schema.required ?? []);
	for (const [key, propertySchema] of Object.entries(schema.properties)) {
		if (!(key in object)) continue;
		if (object[key] === null && !required.has(key)) {
			delete object[key];
		} else {
			normalizeOptionalNulls(object[key], propertySchema);
		}
	}
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
	const lines =
		issues
			.map((issue) => {
				const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "root";
				return `  - ${path}: ${issue.message}`;
			})
			.join("\n") || "Unknown validation error";
	return lines;
}

/**
 * Finds a tool by name and validates the tool call arguments against its zod schema.
 * @param tools Array of tool definitions
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error if tool is not found or validation fails
 */
export function validateToolCall(tools: Tool[], toolCall: ToolCall): unknown {
	const tool = tools.find((t) => t.name === toolCall.name);
	if (!tool) {
		throw new Error(`Tool "${toolCall.name}" not found`);
	}
	return validateToolArguments(tool, toolCall);
}

/**
 * Validates tool call arguments against the tool's zod schema.
 * @param tool The tool definition with a zod schema
 * @param toolCall The tool call from the LLM
 * @returns The validated (and potentially coerced) arguments
 * @throws Error with formatted message if validation fails
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): unknown {
	const args = structuredClone(toolCall.arguments);
	const jsonSchema = schemaOf(tool.parameters);
	normalizeOptionalNulls(args, jsonSchema);

	const validator = getValidator(tool.parameters);
	const firstParse = validator.safeParse(args);
	if (firstParse.success) return firstParse.data;

	// Coerce primitives toward the schema types (mirrors pi's Value.Convert plus
	// JSON-schema coercion pass), then validate once more.
	const coerced = coerceWithJsonSchema(args, jsonSchema);
	const secondParse = validator.safeParse(coerced);
	if (secondParse.success) return secondParse.data;
	const thirdParse = validator.safeParse(args);
	if (thirdParse.success) return thirdParse.data;

	const issues = (secondParse.error ?? thirdParse.error).issues;
	const errorMessage = `Validation failed for tool "${toolCall.name}":\n${formatIssues(issues)}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`;

	throw new Error(errorMessage);
}
