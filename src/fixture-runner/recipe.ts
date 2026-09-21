export * from '@onionsoup/implementation/fixture/recipe';
import { renderFixture as render, runFixture as run } from '@onionsoup/implementation/fixture/recipe';
import { workflowEvents } from '../workflow-events.ts';
export const renderFixture = (directory: string) => render(directory, workflowEvents);
export const runFixture: typeof run = async (which, options) => { const w = await run(which, options); await renderFixture(options.directory); return w; };
