import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentId, capabilityCatalog, capabilityManifest } from './capabilities.ts';
import { workflowEvents } from './workflow-events.ts';

try {
  const [command, argument, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Unexpected arguments');
  let result: unknown;
  if (command === 'list' && !argument) result = capabilityCatalog();
  else if (command === 'describe' && argument) result = capabilityManifest(AgentId.parse(argument));
  else if (command === 'events' && argument) {
    const file = (await stat(argument)).isDirectory() ? join(argument, 'packet.json') : argument;
    const bytes = await readFile(file, 'utf8');
    result = workflowEvents(JSON.parse(bytes));
  } else throw new Error('Usage');
  console.log(JSON.stringify(result, null, 2));
} catch {
  // Parsing errors can echo untrusted input or provider content. Keep CLI diagnostics inert.
  console.error('Unable to inspect input. Usage: agents list | describe AGENT_ID | events RECORD.json|PACKET_DIRECTORY');
  process.exitCode = 1;
}
