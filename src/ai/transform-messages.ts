// Port of earendil-works/pi v0.87.1 (MIT): packages/ai/src/api/transform-messages.ts
// https://github.com/earendil-works/pi/blob/v0.87.1/packages/ai/src/api/transform-messages.ts
//
// The api/ folder's provider-agnostic half: repair a transcript before it is
// serialized for any provider. In pico-agent each wire adapter called this; in
// pico-langchain the stream bridge calls it once before converting to LangChain
// messages, so every chat model gets the same repaired transcript.

import type { AssistantMessage, ImageContent, Message, TextContent, ToolCall, ToolResultMessage } from "./types.ts";
import type { AgentModel } from "./models.ts";

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

function replaceImagesWithPlaceholder(content: (TextContent | ImageContent)[], placeholder: string): TextContent[] {
	const result: TextContent[] = [];
	let previousWasPlaceholder = false;

	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) {
				result.push({ type: "text", text: placeholder });
			}
			previousWasPlaceholder = true;
			continue;
		}

		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}

	return result;
}

function downgradeUnsupportedImages(messages: Message[], model: AgentModel): Message[] {
	if (model.input.includes("image")) {
		return messages;
	}

	return messages.map((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
			};
		}

		if (msg.role === "toolResult") {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
			};
		}

		return msg;
	});
}

/**
 * Normalize a transcript for the target model.
 *
 * - Downgrades images to placeholders for non-vision models.
 * - Keeps/redacts/converts thinking blocks depending on whether the assistant
 *   message came from the same model (signatures are model-bound).
 * - Strips `thoughtSignature` from tool calls crossing models.
 * - Optionally normalizes tool call IDs (e.g. OpenAI Responses API IDs that
 *   violate another provider's `^[a-zA-Z0-9_-]+$` contract) and rewrites the
 *   matching tool results to the normalized IDs.
 * - Drops errored/aborted assistant turns (incomplete, unsafe to replay).
 * - Synthesizes error tool results for orphaned tool calls so every provider's
 *   "each call must be answered" contract holds; system messages that would
 *   land between a call and its results are held back.
 */
export function transformMessages(
	messages: Message[],
	model: AgentModel,
	normalizeToolCallId?: (id: string, model: AgentModel, source: AssistantMessage) => string,
): Message[] {
	// Build a map of original tool call IDs to normalized IDs
	const toolCallIdMap = new Map<string, string>();
	// Normalize null/undefined content from untyped callers (custom tools, hand-built
	// histories, old session files) so downstream code can rely on the type contract.
	const normalizedMessages = messages.map((msg) => (msg.content == null ? { ...msg, content: [] } : msg));
	const imageAwareMessages = downgradeUnsupportedImages(normalizedMessages, model);

	// First pass: transform messages (unsupported image downgrade, thinking blocks, tool call ID normalization)
	const transformed: Message[] = imageAwareMessages.map((msg): Message => {
		// System and user messages pass through unchanged
		if (msg.role === "system" || msg.role === "user") {
			return msg;
		}

		// Handle toolResult messages - normalize toolCallId if we have a mapping
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}

		// Assistant messages need transformation check
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const isSameModel =
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				assistantMsg.model === model.id;

			const transformedContent = assistantMsg.content.flatMap(
				(block): AssistantMessage["content"] => {
					if (block.type === "thinking") {
						// Redacted thinking is opaque encrypted content, only valid for the same model.
						// Drop it for cross-model to avoid API errors.
						if (block.redacted) {
							return isSameModel ? [block] : [];
						}
						// For same model: keep thinking blocks with signatures (needed for replay)
						// even if the thinking text is empty (OpenAI encrypted reasoning)
						if (isSameModel && block.thinkingSignature) return [block];
						// Skip empty thinking blocks, convert others to plain text
						if (!block.thinking || block.thinking.trim() === "") return [];
						if (isSameModel) return [block];
						return [
							{
								type: "text" as const,
								text: block.thinking,
							},
						];
					}

					if (block.type === "text") {
						if (isSameModel) return [block];
						return [
							{
								type: "text" as const,
								text: block.text,
							},
						];
					}

					if (block.type === "toolCall") {
						const toolCall = block as ToolCall;
						let normalizedToolCall: ToolCall = toolCall;

						if (!isSameModel && toolCall.thoughtSignature) {
							normalizedToolCall = { ...toolCall };
							delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
						}

						if (!isSameModel && normalizeToolCallId) {
							const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
							if (normalizedId !== toolCall.id) {
								toolCallIdMap.set(toolCall.id, normalizedId);
								normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
							}
						}

						return [normalizedToolCall];
					}

					return [block];
				},
			);

			return {
				...assistantMsg,
				content: transformedContent,
			};
		}
		return msg;
	});

	// Second pass: insert synthetic empty tool results for orphaned tool calls
	// This preserves thinking signatures and satisfies API requirements
	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();
	// System messages are transparent to tool-call accounting: one that lands between a tool
	// call and its results is held back and emitted after the results (synthetic ones
	// included), so it never causes a duplicate result for a call that is answered later.
	const heldSystemMessages: Message[] = [];
	const closePendingToolCalls = () => {
		if (pendingToolCalls.length > 0) {
			for (const tc of pendingToolCalls) {
				if (!existingToolResultIds.has(tc.id)) {
					result.push({
						role: "toolResult",
						toolCallId: tc.id,
						toolName: tc.name,
						content: [{ type: "text", text: "No result provided" }],
						isError: true,
						timestamp: Date.now(),
					} as ToolResultMessage);
				}
			}
			pendingToolCalls = [];
			existingToolResultIds = new Set();
		}
		result.push(...heldSystemMessages);
		heldSystemMessages.length = 0;
	};

	for (let i = 0; i < transformed.length; i++) {
		const msg = transformed[i];

		if (msg.role === "assistant") {
			// If we have pending orphaned tool calls from a previous assistant, insert synthetic results now
			closePendingToolCalls();

			// Skip errored/aborted assistant messages entirely.
			// These are incomplete turns that shouldn't be replayed:
			// - May have partial content (reasoning without message, incomplete tool calls)
			// - Replaying them can cause API errors (e.g., OpenAI "reasoning without following item")
			// - The model should retry from the last valid state
			const assistantMsg = msg as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				continue;
			}

			// Track tool calls from this assistant message
			const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall") as ToolCall[];
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set();
			}

			result.push(msg);
		} else if (msg.role === "toolResult") {
			existingToolResultIds.add(msg.toolCallId);
			result.push(msg);
		} else if (msg.role === "system") {
			if (pendingToolCalls.length > 0) {
				heldSystemMessages.push(msg);
			} else {
				result.push(msg);
			}
		} else if (msg.role === "user") {
			// A new user turn interrupts tool flow - insert synthetic results for orphaned calls
			closePendingToolCalls();
			result.push(msg);
		} else {
			result.push(msg);
		}
	}

	// If the conversation ends with unresolved tool calls, synthesize results now.
	closePendingToolCalls();

	return result;
}
