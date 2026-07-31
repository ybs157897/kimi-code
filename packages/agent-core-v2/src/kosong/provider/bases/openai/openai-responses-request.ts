import type { ContentPart, Message } from '#/kosong/contract/message';
import { extractText, isToolDeclarationOnlyMessage } from '#/kosong/contract/message';
import type { ResponseFormat, ToolCallIdPolicy } from '#/kosong/contract/provider';
import type { Tool } from '#/kosong/contract/tool';

import { usesOpenAIResponsesDeveloperRole } from './openai-responses-capability';
import {
  isMediaPart,
  TOOL_RESULT_MEDIA_PLACEHOLDER,
  TOOL_RESULT_MEDIA_PROMPT,
  type ToolMessageConversion,
} from './openai-common';
import { sanitizeOpenAIResponsesCallId } from '../tool-call-id';

export const OPENAI_RESPONSES_TOOL_CALL_ID_POLICY: ToolCallIdPolicy = {
  normalize: (id) => sanitizeOpenAIResponsesCallId(id, 64),
  maxLength: 64,
};

interface ResponseInputItem {
  [key: string]: unknown;
}

export interface ResponseToolParam {
  type: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}

export function responseFormatToResponsesText(format: ResponseFormat): Record<string, unknown> {
  if (format.type === 'json_object') {
    return { format: { type: 'json_object' } };
  }
  return {
    format: {
      type: 'json_schema',
      name: format.jsonSchema.name,
      schema: format.jsonSchema.schema,
      strict: format.jsonSchema.strict,
      description: format.jsonSchema.description,
    },
  };
}

const OMITTED_AUDIO_PLACEHOLDER = '(audio omitted: unsupported audio format)';
const OMITTED_VIDEO_PLACEHOLDER = '(video omitted: not supported by this provider)';

function contentPartsToInputItems(parts: ContentPart[]): unknown[] {
  const items: unknown[] = [];
  for (const part of parts) {
    switch (part.type) {
      case 'text':
        if (part.text) {
          items.push({ type: 'input_text', text: part.text });
        }
        break;
      case 'image_url':
        items.push({
          type: 'input_image',
          detail: 'auto',
          image_url: part.imageUrl.url,
        });
        break;
      case 'audio_url': {
        const mapped = mapAudioUrlToInputItem(part.audioUrl.url);
        items.push(mapped ?? { type: 'input_text', text: OMITTED_AUDIO_PLACEHOLDER });
        break;
      }
      case 'video_url':
        items.push({ type: 'input_text', text: OMITTED_VIDEO_PLACEHOLDER });
        break;
      case 'think':
        break;
    }
  }
  return items;
}

function contentPartsToOutputItems(parts: ContentPart[]): unknown[] {
  const items: unknown[] = [];
  for (const part of parts) {
    if (part.type === 'text' && part.text) {
      items.push({ type: 'output_text', text: part.text, annotations: [] });
    }
  }
  return items;
}

function messageContentToFunctionOutputItems(content: ContentPart[]): unknown[] {
  const items: unknown[] = [];
  for (const part of content) {
    switch (part.type) {
      case 'text':
        if (part.text) {
          items.push({ type: 'input_text', text: part.text });
        }
        break;
      case 'image_url':
        items.push({ type: 'input_image', image_url: part.imageUrl.url });
        break;
      case 'audio_url': {
        const mapped = mapAudioUrlToInputItem(part.audioUrl.url);
        items.push(mapped ?? { type: 'input_text', text: OMITTED_AUDIO_PLACEHOLDER });
        break;
      }
      case 'video_url':
        items.push({ type: 'input_text', text: OMITTED_VIDEO_PLACEHOLDER });
        break;
      case 'think':
        break;
    }
  }
  return items;
}

function mapAudioUrlToInputItem(url: string): unknown {
  if (url.startsWith('data:audio/')) {
    try {
      const parts = url.split(',', 2);
      if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) return null;
      const header = parts[0];
      const b64 = parts[1];
      const subtypePart = header.split('/')[1];
      if (subtypePart === undefined) return null;
      const [subtypeHead = ''] = subtypePart.split(';');
      const subtype = subtypeHead.toLowerCase();
      const ext =
        subtype === 'mp3' || subtype === 'mpeg' ? 'mp3' : subtype === 'wav' ? 'wav' : null;
      if (ext === null) return null;
      return { type: 'input_file', file_data: b64, filename: `inline.${ext}` };
    } catch {
      return null;
    }
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return { type: 'input_file', file_url: url };
  }
  return null;
}

function convertMessage(
  message: Message,
  modelName: string,
  toolMessageConversion: ToolMessageConversion,
): ResponseInputItem[] {
  let role: string = message.role;
  if (usesOpenAIResponsesDeveloperRole(modelName) && role === 'system') {
    role = 'developer';
  }

  if (role === 'tool') {
    const callId = message.toolCallId ?? '';
    let output: string | unknown[];
    if (toolMessageConversion === 'extract_text') {
      const text = extractText(message);
      output =
        text.length === 0 && message.content.some(isMediaPart)
          ? TOOL_RESULT_MEDIA_PLACEHOLDER
          : text;
    } else {
      output = messageContentToFunctionOutputItems(message.content);
    }
    return [
      {
        call_id: callId,
        output,
        type: 'function_call_output',
      },
    ];
  }

  const result: ResponseInputItem[] = [];

  if (message.content.length > 0) {
    const pendingParts: ContentPart[] = [];

    const flushPendingParts = (): void => {
      if (pendingParts.length === 0) return;
      if (role === 'assistant') {
        result.push({
          content: contentPartsToOutputItems(pendingParts),
          role,
          type: 'message',
        });
      } else {
        result.push({
          content: contentPartsToInputItems(pendingParts),
          role,
          type: 'message',
        });
      }
      pendingParts.length = 0;
    };

    let i = 0;
    const n = message.content.length;
    while (i < n) {
      const part = message.content[i];
      if (part === undefined) break;
      if (part.type === 'think') {
        flushPendingParts();
        const encryptedValue = part.encrypted;
        const summaries: unknown[] = [{ type: 'summary_text', text: part.think }];
        i += 1;
        while (i < n) {
          const nextPart = message.content[i];
          if (nextPart === undefined) break;
          if (nextPart.type !== 'think') break;
          if (nextPart.encrypted !== encryptedValue) break;
          summaries.push({ type: 'summary_text', text: nextPart.think });
          i += 1;
        }
        result.push({
          summary: summaries,
          type: 'reasoning',
          encrypted_content: encryptedValue,
        });
      } else {
        pendingParts.push(part);
        i += 1;
      }
    }

    flushPendingParts();
  }

  for (const toolCall of message.toolCalls) {
    result.push({
      arguments: toolCall.arguments ?? '{}',
      call_id: toolCall.id,
      name: toolCall.name,
      type: 'function_call',
    });
  }

  return result;
}

export function convertTool(tool: Tool): ResponseToolParam {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  };
}

export function convertHistoryMessages(
  history: readonly Message[],
  modelName: string,
  toolMessageConversion: ToolMessageConversion,
): unknown[] {
  const input: unknown[] = [];
  const pendingToolResultMedia: unknown[] = [];

  const flushPendingMedia = (): void => {
    if (pendingToolResultMedia.length === 0) return;
    input.push({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: TOOL_RESULT_MEDIA_PROMPT }, ...pendingToolResultMedia],
    });
    pendingToolResultMedia.length = 0;
  };

  for (const msg of history) {
    if (isToolDeclarationOnlyMessage(msg)) continue;
    if (msg.role !== 'tool') {
      flushPendingMedia();
    }
    input.push(...convertMessage(msg, modelName, toolMessageConversion));
    if (msg.role === 'tool' && toolMessageConversion === 'extract_text') {
      pendingToolResultMedia.push(
        ...messageContentToFunctionOutputItems(msg.content.filter(isMediaPart)),
      );
    }
  }

  flushPendingMedia();
  return input;
}
