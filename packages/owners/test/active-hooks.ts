import plugin from '../src/plugin.ts';

/** Construct active hooks without weakening the sandbox guard for test execution. */
export async function withActiveHooks(...args: Parameters<typeof plugin.server>) {
  const previous = process.env.ONIONSOUP_SANDBOX;
  try {
    delete process.env.ONIONSOUP_SANDBOX;
    return await plugin.server(...args);
  } finally {
    if (previous === undefined) delete process.env.ONIONSOUP_SANDBOX;
    else process.env.ONIONSOUP_SANDBOX = previous;
  }
}
