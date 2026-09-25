import { SKILLS_DIRECTORY } from './owner-agents.ts';

/**
 * Read-only commands every owner may run in chat without asking the person. Before this, each owner had its own
 * allowlist and owners asked the person ~700 times in a few days, mostly for `grep -n`, `sed -n` and `git log`. Only
 * commands that cannot write are here (no `gh api`, `echo` or interpreters), and the few flags that make a reader
 * write are sent back to asking. Bash rules are a convenience, not a boundary (AGENTS rule 3): this removes prompts,
 * it does not grant anything the sandbox or the person's gates would otherwise stop.
 */
export const READ_ONLY_CHAT_BASH: Record<string, 'allow' | 'ask'> = {
  'grep *': 'allow',
  'rg *': 'allow',
  'sed -n *': 'allow',
  'sed * -i*': 'ask',
  'sed -n -i*': 'ask',
  'cat *': 'allow',
  'head *': 'allow',
  'tail *': 'allow',
  'wc *': 'allow',
  'ls': 'allow',
  'ls *': 'allow',
  'jq *': 'allow',
  'find *': 'allow',
  'find * -delete*': 'ask',
  'find * -exec*': 'ask',
  'find * -execdir*': 'ask',
  'git status*': 'allow',
  'git log*': 'allow',
  'git diff*': 'allow',
  'git show*': 'allow',
  'git branch': 'allow',
  'git branch -a*': 'allow',
  'git branch -r*': 'allow',
  'git branch --list*': 'allow',
  'git rev-parse*': 'allow',
  'git ls-files*': 'allow',
  'gh pr view*': 'allow',
  'gh pr list*': 'allow',
  'gh pr checks*': 'allow',
  'gh pr diff*': 'allow',
  'gh issue view*': 'allow',
  'gh issue list*': 'allow',
  'gh run view*': 'allow',
  'gh run list*': 'allow',
};

/**
 * An owner's bash rules in chat. opencode applies the last matching rule, so the owner's catch-all comes first, then
 * the read-only baseline, then the owner's own specific rules (an owner's `deny` still wins), then its verify commands.
 */
export function chatBash(ownerBash: Record<string, string>, verify: readonly string[]) {
  const { '*': catchAll = 'ask', ...specific } = ownerBash;
  return {
    '*': catchAll,
    ...READ_ONLY_CHAT_BASH,
    ...specific,
    ...Object.fromEntries(verify.map(command => [`${command}*`, 'allow'])),
  };
}

/**
 * Paths outside an owner's directory it may touch without asking: its own scratch space under opencode's temporary
 * directory, and the skills it works by (a skill's supporting prompts sit next to it). Other owners' desks and
 * onionsoup's state still ask.
 */
export const CHAT_EXTERNAL_DIRECTORIES: Record<string, 'allow' | 'ask'> = {
  '*': 'ask',
  '/tmp/opencode/*': 'allow',
  [`${SKILLS_DIRECTORY.replace(/\/$/, '')}/*`]: 'allow',
};
