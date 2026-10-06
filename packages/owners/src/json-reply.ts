/**
 * Hires and the decision watcher ask for their deliverable as JSON in the reply text, parsed and validated by the
 * caller. opencode's structured output forces a tool call, which Copilot's Claude models refuse and other models
 * reject schemas for, so it is not used.
 */

interface ReplyParts { parts?: { type: string; text?: string }[] }

/** What to append to a brief so the final reply is one JSON object matching `schema`. */
export function jsonInstruction(schema: Record<string, unknown>) {
  return `\n\nWhen you are done, your final reply must be only one JSON object that matches this JSON Schema, with no other text:\n${JSON.stringify(schema)}`;
}

/** The text parts of a reply, joined. */
export function replyText(reply: ReplyParts) {
  return (reply.parts ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('');
}

/** The JSON object in a reply: a fenced json block if there is one, else the outermost braces; the text if neither parses. */
export function jsonFromText(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].at(-1)?.[1];
  const braces = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  for (const candidate of [fenced, braces]) {
    if (!candidate?.trim()) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Not JSON: try the next candidate, and let the schema reject the text if none parses.
    }
  }
  return text;
}
