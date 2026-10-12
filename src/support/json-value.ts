// Vendored from earendil-works/pi v0.87.1 (MIT)
// JSON value helpers shared by transcripts, sessions, and tool results.

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

export interface JsonObject {
	[key: string]: JsonValue;
}
