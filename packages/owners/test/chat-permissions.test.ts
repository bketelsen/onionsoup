import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bashAction } from '../src/bash-rules.ts';
import { CHAT_EXTERNAL_DIRECTORIES, chatBash } from '../src/chat-permissions.ts';
import { SKILLS_DIRECTORY } from '../src/owner-agents.ts';

const askByDefault = chatBash({ '*': 'ask' }, ['make check']);

test('owners read without asking: the read-only baseline sits between their catch-all and their own rules', () => {
  for (const command of ['grep -n foo src/a.ts', 'sed -n 1,20p README.md', 'git log --oneline -5', 'git status --short', 'gh pr view 12', 'find . -name "*.yaml"', 'ls', 'cat docs/x.md | head -20']) {
    assert.equal(bashAction(askByDefault, command), 'allow', command);
  }
  assert.equal(bashAction(askByDefault, 'make check'), 'allow', 'verify commands still run');
});

test('the baseline never lets a reader write, and anything else still asks', () => {
  for (const command of ['sed -i s/a/b/ file', 'sed -n -i 1p file', 'find . -name x -delete', 'find . -exec rm {} ;', 'gh api -X DELETE repos/a/b', 'echo x', 'python3 -c "print(1)"', 'git push', 'rm file']) {
    assert.equal(bashAction(askByDefault, command), 'ask', command);
  }
});

test("an owner's own rules still win over the baseline, and its catch-all is kept", () => {
  const strict = chatBash({ '*': 'deny', 'grep *': 'deny', 'git *': 'deny' }, []);
  assert.equal(bashAction(strict, 'grep -n x y'), 'deny');
  assert.equal(bashAction(strict, 'git log'), 'deny');
  assert.equal(bashAction(strict, 'sed -n 1p x'), 'allow', 'the baseline applies where the owner says nothing specific');
  assert.equal(bashAction(strict, 'curl example.com'), 'deny');
});

test('owners touch their scratch space and their skills outside the desk without asking; other paths still ask', () => {
  assert.equal(bashAction(CHAT_EXTERNAL_DIRECTORIES, '/tmp/opencode/dry/run.log'), 'allow');
  assert.equal(bashAction(CHAT_EXTERNAL_DIRECTORIES, `${SKILLS_DIRECTORY}subagent-driven-development/implementer-prompt.md`), 'allow');
  assert.equal(bashAction(CHAT_EXTERNAL_DIRECTORIES, '/var/home/bjk/.local/share/onionsoup/desks/other/README.md'), 'ask');
});
