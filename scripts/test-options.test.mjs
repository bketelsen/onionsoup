import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { testArguments } from "./test-options.mjs";

test("test fan-out is bounded in actual child argv, with validated environment and CLI overrides", () => {
  assert.deepEqual(testArguments(["fixture.test.ts"], {}), [
    "--conditions=onionsoup-source", "--import", "tsx", "--test", "--test-concurrency=4", "fixture.test.ts",
  ]);
  assert.ok(testArguments([], { ONIONSOUP_TEST_CONCURRENCY: "2" }).includes("--test-concurrency=2"));
  assert.ok(testArguments(["--test-concurrency", "3"], {}).includes("--test-concurrency=3"));
  assert.ok(testArguments(["--test-concurrency=5"], { ONIONSOUP_TEST_CONCURRENCY: "2" }).includes("--test-concurrency=5"));
  for (const value of ["0", "-1", "1.5", "Infinity", "", "999999999999999999999"]) {
    assert.throws(() => testArguments([], { ONIONSOUP_TEST_CONCURRENCY: value }), /test_concurrency_invalid/);
    assert.throws(() => testArguments([`--test-concurrency=${value}`], {}), /test_concurrency_invalid/);
  }
  assert.throws(() => testArguments(["--test-concurrency"], {}), /test_concurrency_invalid/);
});

test("test runner rejects invalid fan-out before starting Node", () => {
  const outcome = spawnSync(process.execPath, ["scripts/test.mjs", "--test-concurrency=0"], { encoding: "utf8" });
  assert.notEqual(outcome.status, 0);
  assert.match(outcome.stderr, /test_concurrency_invalid/);
  assert.doesNotMatch(outcome.stderr, /not allowed in NODE_OPTIONS/);
});

test("the real spawned test Node receives the cap in argv, not NODE_OPTIONS", () => {
  const directory = mkdtempSync(join(tmpdir(), "test-argv-"));
  const observer = join(directory, "observe.mjs");
  const fixture = join(directory, "fixture.mjs");
  writeFileSync(observer, 'console.log("TEST_CHILD_ARGV", JSON.stringify(process.execArgv));\n');
  writeFileSync(fixture, 'import { test } from "node:test"; test("fixture", () => {});\n');
  try {
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    for (const [override, expected] of [[[], 4], [["--test-concurrency=2"], 2]]) {
      const outcome = spawnSync(process.execPath, ["scripts/test.mjs", ...override, fixture], {
        encoding: "utf8", env: { ...environment, ONIONSOUP_TEST_CONCURRENCY: "4",
          NODE_OPTIONS: `--import=${pathToFileURL(observer).href}` },
      });
      assert.equal(outcome.status, 0, outcome.stderr);
      assert.match(outcome.stdout, new RegExp(`TEST_CHILD_ARGV .*--test-concurrency=${expected}`));
      assert.doesNotMatch(outcome.stderr, /not allowed in NODE_OPTIONS/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
