import pino from 'pino';
import { readTailLinesSync } from './tail-reader.js';

const logger = pino({ name: 'claude-transcript' });

export interface TranscriptEnrichment {
  text?: string;
  command?: string;
  tokens?: number;
  unknownLineRatio: number;
}

export function readTranscriptTail(
  transcriptPath: string,
  maxLines: number,
): TranscriptEnrichment | null {
  // D-02: seek from the end instead of loading the file. Transcripts reach
  // 70+ MB and this runs inside a hook whose script gives up after 2s.
  const lines = readTailLinesSync(transcriptPath, maxLines);
  if (lines === null) {
    logger.warn({ transcriptPath }, 'failed to read transcript');
    return null;
  }
  if (lines.length === 0) return null;

  let unknownCount = 0;
  let text: string | undefined;
  let command: string | undefined;
  let tokens: number | undefined;

  // Real on-disk transcript shape (verified against ccboard + claude-session-dashboard):
  // each line is `{type, message:{content:[...blocks], usage:{...}}}`. Assistant text and
  // tool_use are content blocks inside `message.content[]`; tokens live in `message.usage`.
  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      unknownCount++;
      continue;
    }

    if (parsed.type !== 'assistant') continue;
    const msg = parsed.message as Record<string, unknown> | undefined;
    if (!msg) continue;

    const contentArr = msg.content as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(contentArr)) {
      for (const block of contentArr) {
        if (block.type === 'text' && typeof block.text === 'string') {
          text = block.text;
        } else if (block.type === 'tool_use') {
          const input = block.input as Record<string, unknown> | undefined;
          if (input && typeof input.command === 'string') {
            command = input.command;
          }
        }
      }
    }

    const usage = msg.usage as Record<string, unknown> | undefined;
    if (usage && typeof usage.output_tokens === 'number') {
      tokens = usage.output_tokens;
    }
  }

  const result: TranscriptEnrichment = {
    unknownLineRatio: unknownCount / lines.length,
  };
  if (text !== undefined) result.text = text;
  if (command !== undefined) result.command = command;
  if (tokens !== undefined) result.tokens = tokens;
  return result;
}
