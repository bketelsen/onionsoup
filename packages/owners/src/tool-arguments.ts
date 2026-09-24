import type { Hooks } from '@opencode-ai/plugin';

// Match opencode 1.18.32's defaults, but materialize them before it builds permission metadata.
// Its JSON encoder rejects undefined metadata values, hiding both the event and permission list.
const WEBFETCH_DEFAULTS = { format: 'markdown', timeout: 30 } as const;

const PREPARE: Record<string, (args: Record<string, unknown>) => void> = {
  webfetch(args) {
    for (const [key, value] of Object.entries(WEBFETCH_DEFAULTS)) {
      if (args[key] === undefined) args[key] = value;
    }
  },
};

/** Mutate the original arguments: opencode retains that object across the before hook. */
export const prepareToolArguments: NonNullable<Hooks['tool.execute.before']> = async (input, output) => {
  PREPARE[input.tool]?.(output.args);
};
