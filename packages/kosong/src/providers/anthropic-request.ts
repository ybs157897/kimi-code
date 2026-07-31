import { ChatProviderError } from '#/errors';
import type { ContentPart, Message } from '#/message';
import type { ResponseFormat } from '#/provider';
import type { Tool } from '#/tool';
import type {
  Tool as AnthropicTool,
  ContentBlockParam,
  MessageParam,
  TextBlockParam,
  ThinkingBlockParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages.js';

import {
  matchKnownAnthropicModelProfile,
  parseAnthropicModelVersion,
} from './anthropic-profile';
import {
  imageUrlPartToAnthropic,
  OMITTED_MEDIA_PLACEHOLDER,
  videoUrlPartToAnthropic,
  type AnthropicImageBlock,
  type AnthropicVideoBlock,
} from './anthropic-media';
import { sanitizeToolCallId, type ToolCallIdPolicy } from './tool-call-id';

export const ANTHROPIC_TOOL_CALL_ID_POLICY: ToolCallIdPolicy = {
  normalize: (id) => sanitizeToolCallId(id, 64),
  maxLength: 64,
};

export function applyResponseFormat(
  kwargs: Record<string, unknown>,
  format: ResponseFormat | undefined,
): void {
  if (format === undefined) return;
  if (format.type === 'json_object') {
    throw new ChatProviderError(
      'Anthropic provider requires a JSON schema for structured response output.',
    );
  }
  const outputConfig =
    kwargs['output_config'] !== undefined && kwargs['output_config'] !== null
      ? { ...(kwargs['output_config'] as Record<string, unknown>) }
      : {};
  outputConfig['format'] = {
    type: 'json_schema',
    schema: format.jsonSchema.schema,
  };
  kwargs['output_config'] = outputConfig;
}

export const CACHE_CONTROL = { type: 'ephemeral' as const };

type CacheableBlock = ContentBlockParam & { cache_control?: { type: 'ephemeral' } };

export function shouldPreserveUnsignedThinking(model: string): boolean {
  return (
    parseAnthropicModelVersion(model) === null &&
    matchKnownAnthropicModelProfile(model) === undefined
  );
}

/**
 * Content block types that support cache_control injection.
 */
const CACHEABLE_TYPES = new Set([
  'text',
  'image',
  'document',
  'search_result',
  'tool_use',
  'tool_result',
  'server_tool_use',
  'web_search_tool_result',
]);

export function injectCacheControlOnLastBlock(messages: MessageParam[]): void {
  const lastMessage = messages.at(-1);
  if (lastMessage === undefined) return;
  const content = lastMessage.content;
  if (!Array.isArray(content) || content.length === 0) return;
  const lastBlock = content.at(-1) as CacheableBlock | undefined;
  if (lastBlock === undefined) return;
  if (CACHEABLE_TYPES.has(lastBlock.type)) {
    lastBlock.cache_control = CACHE_CONTROL;
  }
}

/**
 * Whether a user MessageParam consists solely of `tool_result` blocks. Used to
 * keep tool results bundled with each other (parallel-tool-use spec) while
 * not merging a tool-result user message into an adjacent plain-text user
 * message — the two carry different semantics and must stay separate.
 */
export function isToolResultOnly(message: MessageParam): boolean {
  if (message.role !== 'user') return false;
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((block) => block.type === 'tool_result');
}

export interface AnthropicToolParam extends AnthropicTool {
  cache_control?: { type: 'ephemeral' } | null;
}

export function convertTool(tool: Tool): AnthropicToolParam {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as AnthropicTool['input_schema'],
  };
}

export function toolResultToBlock(toolCallId: string, content: ContentPart[]): ToolResultBlockParam {
  const blocks: Array<TextBlockParam | AnthropicImageBlock | AnthropicVideoBlock> = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) {
        blocks.push({ type: 'text', text: part.text });
      }
    } else if (part.type === 'image_url') {
      blocks.push(imageUrlPartToAnthropic(part.imageUrl.url));
    } else if (part.type === 'video_url') {
      blocks.push(videoUrlPartToAnthropic(part.videoUrl.url));
    } else if (part.type === 'audio_url') {
      const placeholder = OMITTED_MEDIA_PLACEHOLDER[part.type];
      const last = blocks.at(-1);
      if (!(last?.type === 'text' && last.text === placeholder)) {
        blocks.push({ type: 'text', text: placeholder });
      }
    }
  }
  return {
    type: 'tool_result',
    tool_use_id: toolCallId,
    content: blocks,
  } as ToolResultBlockParam;
}

export function convertMessage(message: Message, model: string): MessageParam {
  const role = message.role;

  // system role -> <system>...</system> wrapped user message
  if (role === 'system') {
    const text = message.content
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    return {
      role: 'user',
      content: [{ type: 'text', text: `<system>${text}</system>` }],
    };
  }

  // tool role -> ToolResultBlockParam in user message
  if (role === 'tool') {
    if (message.toolCallId === undefined) {
      throw new ChatProviderError('Tool message missing `toolCallId`.');
    }
    const block = toolResultToBlock(message.toolCallId, message.content);
    return { role: 'user', content: [block as ContentBlockParam] };
  }

  // user or assistant
  const blocks: ContentBlockParam[] = [];
  for (const part of message.content) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text } satisfies TextBlockParam);
    } else if (part.type === 'image_url') {
      blocks.push(imageUrlPartToAnthropic(part.imageUrl.url) as unknown as ContentBlockParam);
    } else if (part.type === 'think') {
      // ThinkPart -> ThinkingBlockParam.
      //
      // Signed: emit the block with its signature. api.anthropic.com requires a
      // valid signature and always supplies one, so Anthropic-sourced history
      // always takes this branch.
      //
      // Unsigned: still PRESERVE the thinking, emitted *without* a `signature`
      // field. Anthropic-compatible backends (e.g. Kimi) stream thinking with
      // no signature_delta, yet reject a tool-call turn whose thinking is gone
      // ("thinking is enabled but reasoning_content is missing"). Dropping it
      // here is what broke multi-step tool use on those backends. Claude
      // models reject unsigned thinking blocks, so those are only preserved
      // for non-Claude Anthropic-compatible models.
      if (part.encrypted !== undefined) {
        blocks.push({
          type: 'thinking',
          thinking: part.think,
          signature: part.encrypted,
        } satisfies ThinkingBlockParam);
      } else if (shouldPreserveUnsignedThinking(model)) {
        blocks.push({ type: 'thinking', thinking: part.think } as unknown as ThinkingBlockParam);
      }
    } else if (part.type === 'video_url') {
      blocks.push(videoUrlPartToAnthropic(part.videoUrl.url) as unknown as ContentBlockParam);
    } else if (part.type === 'audio_url') {
      const placeholder = OMITTED_MEDIA_PLACEHOLDER[part.type];
      const last = blocks.at(-1);
      if (!(last?.type === 'text' && last.text === placeholder)) {
        blocks.push({ type: 'text', text: placeholder } satisfies TextBlockParam);
      }
    }
  }

  // Tool calls -> ToolUseBlockParam
  if (message.toolCalls.length > 0) {
    for (const tc of message.toolCalls) {
      let toolInput: Record<string, unknown> = {};
      if (tc.arguments) {
        try {
          const parsed: unknown = JSON.parse(tc.arguments);
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            toolInput = parsed as Record<string, unknown>;
          } else {
            throw new ChatProviderError('Tool call arguments must be a JSON object.');
          }
        } catch (error) {
          if (error instanceof ChatProviderError) throw error;
          throw new ChatProviderError('Tool call arguments must be valid JSON.');
        }
      }
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: toolInput,
      } satisfies ToolUseBlockParam);
    }
  }

  return { role: role, content: blocks };
}

export function shouldKeepConvertedMessage(message: MessageParam): boolean {
  return message.role !== 'assistant' || message.content.length > 0;
}
