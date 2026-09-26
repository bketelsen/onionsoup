import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { parse } from 'yaml';
import { loadDeclarations, OwnerDeclaration, repositoryNames, type Declarations } from './declarations.ts';
import { familyOf } from './families.ts';
import { isFinished } from './ledger.ts';
import type { Runtime } from './runtime.ts';

const run = promisify(execFile);

/**
 * A steward is an owner the person allowed (with `manages:`) to create, change and retire other owners whose
 * domains match its scope. Host code enforces the scope and keeps authority with the person: a steward never
 * writes grants, deploy targets, incus hosts, tool servers or stewardship, and never changes itself. Every write
 * is validated against the whole configuration and committed to the config repository.
 */
export const AUTHORITY_FIELDS = ['grants', 'deploy', 'incus', 'mcp', 'manages'] as const;


/** What a steward's scope patterns match: the repository or org name, incus:<remotes> or truenas:<host>. */
export function domainKey(domain: OwnerDeclaration['domain']) {
  if (domain.kind === 'github-org') return domain.org;
  if (domain.kind === 'incus') return `incus:${domain.remotes.map(remote => remote.name).join(',')}`;
  if (domain.kind === 'truenas') return `truenas:${domain.ssh.host}`;
  return domain.name;
}

function globToPattern(glob: string) {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`);
}

/** A group is in scope only when every repository in it is; other domains by their key. */
export function inScope(steward: OwnerDeclaration, domain: OwnerDeclaration['domain']) {
  const keys = domain.kind === 'repository-group' ? domain.repositories.map(repository => repository.name) : [domainKey(domain)];
  return keys.every(key => (steward.manages?.owners ?? []).some(glob => globToPattern(glob).test(key)));
}

function requireSteward(declarations: Declarations, stewardId: string) {
  const steward = declarations.owners.get(stewardId);
  if (!steward?.manages) throw new Error(`not_a_steward: ${stewardId} has no manages: section; only the person can let an owner manage owners`);
  return steward;
}

/** Throws with the reason a steward may not write this declaration; returns quietly when it may. */
export function checkOwnerWrite(declarations: Declarations, stewardId: string, candidate: OwnerDeclaration) {
  const steward = requireSteward(declarations, stewardId);
  const existing = declarations.owners.get(candidate.id);
  if (candidate.id === steward.id) throw new Error('refused: a steward does not change its own declaration');
  if (!inScope(steward, candidate.domain)) throw new Error(`refused: ${domainKey(candidate.domain)} is outside ${steward.id}'s scope (${steward.manages!.owners.join(', ')})`);
  if (existing && !inScope(steward, existing.domain)) throw new Error(`refused: ${existing.id} owns ${domainKey(existing.domain)}, outside ${steward.id}'s scope`);
  for (const field of AUTHORITY_FIELDS) {
    const before = existing?.[field] ?? OwnerDeclaration.shape[field].parse(undefined);
    if (!isDeepStrictEqual(candidate[field], before)) throw new Error(`refused: ${field} is authority only the person edits; leave it ${existing ? 'as it is' : 'out'}`);
  }
  checkReportingLine(steward.id, existing, candidate);
  const sameName = [...declarations.owners.values()].find(owner => owner.id !== candidate.id && owner.persona && owner.persona.name === candidate.persona?.name);
  if (sameName) throw new Error(`refused: ${sameName.id} is already called ${sameName.persona!.name}`);
  const sameDomain = [...declarations.owners.values()].find(owner => owner.id !== candidate.id && owner.domain.kind === candidate.domain.kind && domainKey(owner.domain) === domainKey(candidate.domain));
  if (sameDomain) throw new Error(`refused: ${sameDomain.id} already owns ${domainKey(candidate.domain)}`);
  const wanted = new Set(repositoryNames(candidate));
  for (const owner of declarations.owners.values()) {
    const taken = owner.id === candidate.id ? [] : repositoryNames(owner).filter(name => wanted.has(name));
    if (taken.length) throw new Error(`refused: ${owner.id} already owns ${taken.join(', ')}; change or retire that owner first`);
  }
  familyOf(declarations.families, candidate.model);
}

/**
 * A steward may put owners in its scope under itself, or take them back out, but a reporting line to anyone
 * else is the person's: it is never set, changed or cleared by a steward.
 */
function checkReportingLine(stewardId: string, existing: OwnerDeclaration | undefined, candidate: OwnerDeclaration) {
  const before = existing?.reportsTo;
  if (candidate.reportsTo === before) return;
  const namesAnother = (managerId: string | undefined) => managerId !== undefined && managerId !== stewardId;
  if (namesAnother(before) || namesAnother(candidate.reportsTo)) throw new Error('refused: reportsTo may only name you');
}

/** Commit only the paths this write touched, so the person's own uncommitted edits stay theirs. */
async function commitConfig(root: string, paths: readonly string[], message: string) {
  const inRepo = await run('git', ['-C', root, 'rev-parse', '--is-inside-work-tree']).then(() => true, () => false);
  if (!inRepo) return 'not a git repository; not committed';
  await run('git', ['-C', root, 'add', '-A', '--', ...paths]);
  await run('git', ['-C', root, 'commit', '-q', '-m', message, '--', ...paths]);
  return (await run('git', ['-C', root, 'rev-parse', '--short', 'HEAD'])).stdout.trim();
}

/** Validate the whole configuration as it would be with these files written, without touching the real one. */
async function validateWith(root: string, files: Record<string, string | null>) {
  const scratch = await mkdtemp(join(tmpdir(), 'onionsoup-config-'));
  try {
    await cp(root, scratch, { recursive: true, filter: source => !source.includes(`${root}/.git`) });
    for (const [path, text] of Object.entries(files)) {
      if (text === null) await rm(join(scratch, path), { force: true });
      else await writeFile(join(scratch, path), text);
    }
    return await loadDeclarations(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export function parseOwnerYaml(text: string) {
  const parsed = OwnerDeclaration.safeParse(parse(text));
  if (!parsed.success) throw new Error(`invalid declaration: ${parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
  return parsed.data;
}

/** Check a write before the person is asked; returns what the write will do. */
export async function prepareOwnerWrite(runtime: Runtime, stewardId: string, yamlText: string, charter?: string) {
  const candidate = parseOwnerYaml(yamlText);
  checkOwnerWrite(runtime.declarations, stewardId, candidate);
  const root = runtime.declarations.root;
  const files: Record<string, string> = { [`owners/${candidate.id}.yaml`]: yamlText.endsWith('\n') ? yamlText : `${yamlText}\n` };
  if (charter) files[`charters/${candidate.id}.md`] = charter.endsWith('\n') ? charter : `${charter}\n`;
  const hasCharter = charter || (await readFile(join(root, 'charters', `${candidate.id}.md`), 'utf8').then(() => true, () => false));
  if (!hasCharter) throw new Error(`refused: ${candidate.id} needs a charter; pass one`);
  await validateWith(root, files);
  return { candidate, files, created: !runtime.declarations.owners.has(candidate.id) };
}

export async function writeOwner(runtime: Runtime, stewardId: string, prepared: Awaited<ReturnType<typeof prepareOwnerWrite>>) {
  const root = runtime.declarations.root;
  for (const [path, text] of Object.entries(prepared.files)) await writeFile(join(root, path), text);
  const name = prepared.candidate.persona?.name ?? prepared.candidate.id;
  const commit = await commitConfig(root, Object.keys(prepared.files), `${prepared.created ? 'Add' : 'Update'} ${name} (${domainKey(prepared.candidate.domain)}), by ${stewardId}`);
  await runtime.reloadDeclarations();
  const notebook = runtime.notebook(stewardId);
  await notebook.journal({ kind: prepared.created ? 'owner-created' : 'owner-updated', note: `${prepared.candidate.id}: ${name} for ${domainKey(prepared.candidate.domain)} (config ${commit})` });
  await notebook.commit(`journal owner ${prepared.candidate.id}`).catch(() => undefined);
  return commit;
}

/** Check a retirement before the person is asked. Retired declarations move to retired/, kept for the record. */
export async function prepareRetire(runtime: Runtime, stewardId: string, ownerId: string) {
  const steward = requireSteward(runtime.declarations, stewardId);
  const owner = runtime.declarations.owners.get(ownerId);
  if (!owner) throw new Error(`unknown owner: ${ownerId}`);
  if (owner.id === steward.id) throw new Error('refused: a steward does not retire itself');
  if (!inScope(steward, owner.domain)) throw new Error(`refused: ${owner.id} owns ${domainKey(owner.domain)}, outside ${steward.id}'s scope`);
  const open = (await runtime.ledger.list()).filter(item => item.owner === owner.id && !isFinished(item));
  if (open.length) throw new Error(`refused: ${owner.id} has open work (${open.map(item => item.id).join(', ')}); finish or reject it first`);
  await validateWith(runtime.declarations.root, { [`owners/${owner.id}.yaml`]: null });
  return owner;
}

export async function retireOwner(runtime: Runtime, stewardId: string, owner: OwnerDeclaration, reason: string) {
  const root = runtime.declarations.root;
  await mkdir(join(root, 'retired'), { recursive: true });
  await rename(join(root, 'owners', `${owner.id}.yaml`), join(root, 'retired', `${owner.id}.yaml`));
  const commit = await commitConfig(root, [`owners/${owner.id}.yaml`, `retired/${owner.id}.yaml`], `Retire ${owner.persona?.name ?? owner.id} (${domainKey(owner.domain)}), by ${stewardId}: ${reason}`);
  await runtime.reloadDeclarations();
  const notebook = runtime.notebook(stewardId);
  await notebook.journal({ kind: 'owner-retired', note: `${owner.id}: ${reason} (config ${commit})` });
  await notebook.commit(`journal retire ${owner.id}`).catch(() => undefined);
  return commit;
}

const GUIDE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.agents/skills/create-owner/SKILL.md');

/** What a steward needs to write a good owner: the procedure, the owners that exist, the model families. */
export async function stewardGuide(runtime: Runtime, stewardId: string) {
  const steward = requireSteward(runtime.declarations, stewardId);
  const owners = [...runtime.declarations.owners.values()].map(owner =>
    `- ${owner.id}: ${owner.persona ? `${owner.persona.name} (${owner.persona.source})` : 'no persona'}, ${owner.domain.kind} ${domainKey(owner.domain)}, ${owner.model}${inScope(steward, owner.domain) && owner.id !== steward.id ? ' [yours to manage]' : ''}`);
  const families = runtime.declarations.families.families.map(entry => `- ${entry.family}: ${entry.match.join(', ')}`);
  const procedure = await readFile(GUIDE, 'utf8').catch(() => '(create-owner guide unavailable)');
  return [
    `Your scope: owners whose domain matches ${steward.manages!.owners.join(', ')}.`,
    `Authority stays with the person: never set ${AUTHORITY_FIELDS.join(', ')}; the tool refuses them.`,
    `Owners now:\n${owners.join('\n')}`,
    `Model families (an owner's reviewers come from another family than its own model):\n${families.join('\n')}`,
    `Procedure (written for Leto; with this tool you skip the manual validate/commit/sync steps):\n\n${procedure}`,
  ].join('\n\n');
}

/** An owner's declaration and charter as written, so a steward edits the real text rather than a paraphrase. */
export async function ownerFiles(runtime: Runtime, ownerId: string) {
  const root = runtime.declarations.root;
  if (!runtime.declarations.owners.has(ownerId)) throw new Error(`unknown owner: ${ownerId}`);
  const yamlText = await readFile(join(root, 'owners', `${ownerId}.yaml`), 'utf8');
  const charter = await readFile(join(root, 'charters', `${ownerId}.md`), 'utf8').catch(() => '(no charter)');
  return `owners/${ownerId}.yaml:\n\n${yamlText}\n\ncharters/${ownerId}.md:\n\n${charter}`;
}
