import type { Declarations, OwnerDeclaration } from './declarations.ts';

type DomainSummary = (owner: OwnerDeclaration) => string;

const DOMAIN_SUMMARIES: Record<OwnerDeclaration['domain']['kind'], DomainSummary> = {
  'git-repository': owner => (owner.domain.kind === 'git-repository' ? `the ${owner.domain.name} repository` : ''),
  incus: owner => (owner.domain.kind === 'incus'
    ? `incus on ${owner.domain.remotes.map(remote => `${remote.name} (${remote.host}; ${remote.allow.join('/')})`).join(', ')}`
    : ''),
  truenas: owner => (owner.domain.kind === 'truenas'
    ? `the TrueNAS NAS (${owner.domain.ssh.host})${owner.domain.sites.length ? `, hosting ${owner.domain.sites.map(site => `${site.id} (built from ${site.source})`).join(', ')}` : ''}`
    : ''),
};

function displayName(owner: OwnerDeclaration) {
  return owner.persona ? `${owner.persona.name}, ${owner.persona.title}` : `${owner.id} (no persona)`;
}

/**
 * Who owns what, generated from the declarations so it never drifts. Owners use it to know whose
 * evidence to consult and whom to ask, instead of guessing about systems they do not own.
 */
export function rosterText(declarations: Declarations, selfId: string) {
  const lines = [...declarations.owners.values()]
    .filter(owner => owner.id !== selfId)
    .map(owner => {
      const incus = owner.incus ? `; and incus on ${owner.incus.remotes.map(remote => `${remote.name} (${remote.host}; ${remote.allow.join('/')})`).join(', ')}` : '';
      return `- ${displayName(owner)} [owner id: ${owner.id}]: owns ${DOMAIN_SUMMARIES[owner.domain.kind](owner)}${incus}.`;
    });
  return `Other owners in this homelab (consult their evidence with onionsoup_evidence, ask them with onionsoup_ask; never operate their systems):
${lines.join('\n') || '(none)'}`;
}
