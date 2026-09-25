import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { TruenasDomain } from './declarations.ts';
import { expandHome } from './paths.ts';

const run = promisify(execFile);

export const TRUENAS_LIMITS = { toolTimeoutMs: 120_000, sshTimeoutMs: 5 * 60_000, restartWaitMs: 90_000, pollMs: 3_000 };

/** Read KEY=VALUE lines (with optional `export`) from the owner's env file; values are never logged. */
export async function readEnvFile(path: string) {
  const text = await readFile(expandHome(path), 'utf8');
  const pairs = text.split('\n')
    .map(line => line.replace(/^\s*export\s+/, '').match(/^([A-Z_][A-Z0-9_]*)=(.*)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map(match => [match[1]!, match[2]!.trim().replace(/^['"]|['"]$/g, '')]);
  return Object.fromEntries(pairs) as Record<string, string>;
}

/** The environment truenas-mcp needs: host and key from the env file, TLS and write mode from the declaration. */
export async function truenasMcpEnvironment(domain: TruenasDomain, writes: boolean) {
  const file = await readEnvFile(domain.mcp.envFile);
  if (!file.TRUENAS_HOST || !file.TRUENAS_API_KEY) throw new Error(`truenas_env_incomplete: ${domain.mcp.envFile} needs TRUENAS_HOST and TRUENAS_API_KEY`);
  return {
    TRUENAS_HOST: file.TRUENAS_HOST,
    TRUENAS_API_KEY: file.TRUENAS_API_KEY,
    ...(domain.mcp.tlsInsecure ? { TRUENAS_TLS_INSECURE: 'true' } : {}),
    ...(writes ? { TRUENAS_ENABLE_WRITES: 'true' } : {}),
  };
}

/** Use truenas-mcp as an MCP client. Read-only unless `writes`; only host code ever asks for writes. */
export async function withTruenas<T>(domain: TruenasDomain, writes: boolean, use: (call: (tool: string, args?: Record<string, unknown>) => Promise<string>) => Promise<T>) {
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: homedir(), ...(await truenasMcpEnvironment(domain, writes)) };
  const transport = new StdioClientTransport({ command: expandHome(domain.mcp.binary), args: ['serve'], env, stderr: 'ignore' });
  const client = new Client({ name: 'onionsoup', version: '0.1.0' });
  await client.connect(transport);
  try {
    const call = async (tool: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: TRUENAS_LIMITS.toolTimeoutMs });
      const text = (result.content as { type: string; text?: string }[]).map(part => part.text ?? '').join('\n');
      if (result.isError) throw new Error(`${tool}_failed: ${text.slice(0, 300)}`);
      return text;
    };
    return await use(call);
  } finally {
    await client.close().catch(() => undefined);
  }
}

const EVIDENCE_TOOLS: [string, string][] = [
  ['health', 'truenas_health_report'],
  ['system', 'truenas_system_info'],
  ['pools', 'truenas_pool_list'],
  ['apps', 'truenas_app_list'],
  ['alerts', 'truenas_alert_list'],
  ['updates', 'truenas_apps_update_report'],
];

/** Host code writes a read-only snapshot of the NAS into the owner's evidence folder before every wake. */
export async function refreshTruenasEvidence(domain: TruenasDomain, evidenceDirectory: string) {
  const takenAt = new Date().toISOString();
  const sections = await withTruenas(domain, false, async call => {
    const collected: [string, string][] = [];
    for (const [name, tool] of EVIDENCE_TOOLS) collected.push([name, await call(tool).catch(error => `unavailable: ${error instanceof Error ? error.message : error}`)]);
    return collected;
  });
  await mkdir(evidenceDirectory, { recursive: true });
  for (const [name, text] of sections) await writeFile(join(evidenceDirectory, `${name}.json`), text + '\n');
  const sites = domain.sites.map(site => `- ${site.id}: ${site.path} served by app \`${site.app}\` at ${site.url}; content from owner \`${site.source}\``).join('\n');
  const body = sections.map(([name, text]) => `## ${name}\n\n\`\`\`json\n${text.slice(0, 6_000)}\n\`\`\``).join('\n\n');
  await writeFile(join(evidenceDirectory, 'SNAPSHOT.md'), `# TrueNAS snapshot\n\nTaken ${takenAt} by host code through truenas-mcp (read-only).\n\n## Sites you host\n\n${sites || '(none)'}\n\n${body}\n`);
  return `snapshot ${takenAt}`;
}

/** SSH fallback for what the API cannot do (moving files on a dataset). Fixed argv, no shell interpolation of input. */
export async function ssh(domain: TruenasDomain, command: string) {
  const { stdout } = await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `${domain.ssh.user}@${domain.ssh.host}`, command], { timeout: TRUENAS_LIMITS.sshTimeoutMs, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

export async function rsyncTo(domain: TruenasDomain, localDirectory: string, remoteDirectory: string) {
  await run('rsync', ['-a', '--delete', '--rsync-path=sudo rsync', '-e', 'ssh -o BatchMode=yes -o ConnectTimeout=10', `${localDirectory.replace(/\/$/, '')}/`, `${domain.ssh.user}@${domain.ssh.host}:${remoteDirectory}/`], { timeout: TRUENAS_LIMITS.sshTimeoutMs, maxBuffer: 8 * 1024 * 1024 });
}
