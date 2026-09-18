import assert from 'node:assert/strict';
import test from 'node:test';
import { testNavigation } from '../src/test-navigation.ts';

test('a distant fixture consumer points to its test and assertion without treating the hint as coverage', () => {
  const lines = ['function createAuthError() {', '  return { error: "expired" };', '}',
    ...Array(100).fill(''), 'test("reports expired authorization", () => {',
    '  const result = translate(createAuthError());', '  expect(result.category).toBe("unauthorized");', '});'];
  const hints = testNavigation(lines, 1, 3);
  assert.deepEqual(hints.fixtureReferences, [{ symbol: 'createAuthError', line: 105,
    preview: 'const result = translate(createAuthError());',
    precedingTest: { line: 104, preview: 'test("reports expired authorization", () => {' }, followingAssertionLine: 106 }]);
  assert.equal(hints.nextAssertionLine, null);
  assert.equal(hints.referencesTruncated, false);
});

test('continuation hints stop at a new test and at the 120-line search bound', () => {
  assert.equal(testNavigation(['test("one", () => {', '  setup();', '  expect(result).toBe(true);', '});'], 1, 2).nextAssertionLine, 3);
  assert.equal(testNavigation(['test("one", () => {});', 'test("other", () => {', 'expect(unrelated).toBe(true);'], 1, 1).nextAssertionLine, null);
  assert.equal(testNavigation(['setup();', ...Array(120).fill(''), 'expect(result).toBe(true);'], 1, 1).nextAssertionLine, null);
});

test('fixture hints are bounded, skip line comments and match symbols literally including dollar signs', () => {
  const lines = ['function fixture$() {}', 'function extra() {}', 'function third() {}', '// fixture$()',
    'test("uses fixture", () => {', ...Array(8).fill('fixture$();'), 'expect(true).toBe(true);', '});'];
  const hints = testNavigation(lines, 1, 3);
  assert.equal(hints.fixtureReferences.length, 2);
  assert.equal(hints.referencesTruncated, true);
  assert.deepEqual(hints.fixtureReferences.map(r => r.line), [6, 7]);
  assert.ok(hints.fixtureReferences.every(r => r.symbol === 'fixture$'));
});
