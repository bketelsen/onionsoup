import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';

// Scripted provider for plumbing tests and demos; this does not assess issue content.
export function fixtureModel(responses: unknown[]) {
  let next = 0;
  return new MockLanguageModelV3({
    provider: 'fixture', modelId: 'scripted',
    doStream: async () => {
      if (next >= responses.length) throw new Error('Fixture exhausted');
      const input = responses[next++];
      if (input instanceof Error) throw input;
      return { stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start' as const, warnings: [] },
          { type: 'tool-call' as const, toolCallId: `fixture-${next}`, toolName: 'submit_assessment', input: JSON.stringify(input) },
          { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
            usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } } },
        ], initialDelayInMs: null, chunkDelayInMs: null,
      }) };
    },
  });
}
