import { directReports, managerOf, type Declarations, type OwnerDeclaration } from './declarations.ts';

type DomainSummary = (owner: OwnerDeclaration) => string;

const DOMAIN_SUMMARIES: Record<OwnerDeclaration['domain']['kind'], DomainSummary> = {
  'git-repository': owner => (owner.domain.kind === 'git-repository' ? `the ${owner.domain.name} repository` : ''),
  'repository-group': owner => (owner.domain.kind === 'repository-group'
    ? `the ${owner.domain.name} repositories (${owner.domain.repositories.map(repository => repository.name).join(', ')})`
    : ''),
  incus: owner => (owner.domain.kind === 'incus'
    ? `incus on ${owner.domain.remotes.map(remote => `${remote.name} (${remote.host}; ${remote.allow.join('/')})`).join(', ')}`
    : ''),
  'github-org': owner => (owner.domain.kind === 'github-org' ? `the ${owner.domain.org} GitHub organization (and watches over its owners)` : ''),
  truenas: owner => (owner.domain.kind === 'truenas'
    ? `the TrueNAS NAS (${owner.domain.ssh.host})${owner.domain.sites.length ? `, hosting ${owner.domain.sites.map(site => `${site.id} (built from ${site.source})`).join(', ')}` : ''}`
    : ''),
};

/** What an owner owns, in a phrase: "the frostyard/snosi repository", "the TrueNAS NAS (…)". */
export function domainSummary(owner: OwnerDeclaration) {
  return DOMAIN_SUMMARIES[owner.domain.kind](owner);
}

function displayName(owner: OwnerDeclaration) {
  return owner.persona ? `${owner.persona.name}, ${owner.persona.title}` : `${owner.id} (no persona)`;
}

function ownerLine(owner: OwnerDeclaration, selfId: string) {
  const incus = owner.incus ? `; and incus on ${owner.incus.remotes.map(remote => `${remote.name} (${remote.host}; ${remote.allow.join('/')})`).join(', ')}` : '';
  const you = owner.id === selfId ? ' (you)' : '';
  return `${displayName(owner)}${you} [owner id: ${owner.id}]: owns ${DOMAIN_SUMMARIES[owner.domain.kind](owner)}${incus}.`;
}

/** Owners under a manager (or, without one, the owners nobody manages), each followed by its own reports. */
function treeLines(declarations: Declarations, selfId: string, managerId: string | undefined, depth: number): string[] {
  const owners = managerId === undefined
    ? [...declarations.owners.values()].filter(owner => !managerOf(declarations, owner.id))
    : directReports(declarations, managerId);
  return owners.flatMap(owner => [
    `${'  '.repeat(depth)}- ${ownerLine(owner, selfId)}`,
    ...treeLines(declarations, selfId, owner.id, depth + 1),
  ]);
}

/**
 * Who owns what, generated from the declarations so it never drifts, drawn as the org chart: an owner's direct
 * reports are indented under it. Owners use it to know whose evidence to consult and whom to ask, instead of
 * guessing about systems they do not own.
 */
export function rosterText(declarations: Declarations, selfId: string) {
  return `Owners by reporting line (consult others' evidence with onionsoup_evidence, ask them with onionsoup_ask; never operate their systems):
${treeLines(declarations, selfId, undefined, 0).join('\n')}`;
}

function reference(owner: OwnerDeclaration) {
  return `${displayName(owner)} [owner id: ${owner.id}]`;
}

/** Where an owner sits in the org chart, in its own terms; empty when it has neither a manager nor reports. */
export function orgText(declarations: Declarations, selfId: string) {
  const manager = managerOf(declarations, selfId);
  const reports = directReports(declarations, selfId);
  const lines = [
    ...(manager ? [`Your manager: ${reference(manager)}.`] : []),
    ...(reports.length ? [`Your direct reports: ${reports.map(reference).join('; ')}. Delegate work in their domains to them (onionsoup_request_work) instead of doing it yourself.`] : []),
  ];
  return lines.join('\n');
}
