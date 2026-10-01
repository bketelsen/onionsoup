import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Tests make scratch directories with mkdtemp(join(tmpdir(), ...)) and leave them behind. Each run of the suite left
// about 22k files in /tmp, and /tmp (a tmpfs) ran out of inodes on 2026-09-24. Every run now gets its own TMPDIR,
// which os.tmpdir() honours, and the whole directory is removed when the run ends, pass or fail.
function shardArguments(value) {
  if (value === undefined) return [];
  if (!/^[1-9]\d*\/[1-9]\d*$/.test(value)) throw new Error("test_shard_invalid");
  const [index, total] = value.split("/").map(Number);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index > total) {
    throw new Error("test_shard_invalid");
  }
  return [`--test-shard=${value}`];
}

const shard = shardArguments(process.env.ONIONSOUP_TEST_SHARD);
const runDirectory = mkdtempSync(path.join(tmpdir(), "onionsoup-test-run-"));
const args = ["--conditions=onionsoup-source", "--import", "tsx", "--test", ...shard, ...process.argv.slice(2)];
// The outer CI suite owns its partition. Nested fixture checks must still run their whole suite.
const environment = { ...process.env, TMPDIR: runDirectory };
delete environment.ONIONSOUP_TEST_SHARD;
const child = spawn(process.execPath, args, { stdio: "inherit", env: environment });

function cleanUp() {
  rmSync(runDirectory, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  cleanUp();
  process.exitCode = code ?? (signal ? 1 : 0);
});
