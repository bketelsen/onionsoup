import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import filesystem, { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { OPERATOR_GO_LIMITS } from '../src/operator-check-go.ts';
import { OPERATOR_CHECK_RUNNER_LIMITS, preflightOperatorCheck, runOperatorCheck,
  validateOperatorCheckInput } from '../src/operator-check-runner.ts';

const configuredGoRoot = process.env.ONIONSOUP_HOST_GO_ROOT;
function file(path: string, content: string) { return { path, content: Buffer.from(content), mode: 0o100600 }; }
const module = file('go.mod', 'module example.com/fixture\n\ngo 1.25.0\n');
const implementation = file('sum.go', 'package fixture\nfunc Sum(a,b int)int{return a+b}\n');
const regression = file('sum_test.go', `package fixture
import "testing"
func TestSum(t *testing.T) { if Sum(2,3)!=5 {t.Fatal("sum regression")} }
`);
const command = ['go', 'test', './...'];

function requireGoRoot() {
  assert.ok(configuredGoRoot, 'Set ONIONSOUP_HOST_GO_ROOT to an installed trusted Go toolchain; these tests never silently skip.');
  return configuredGoRoot;
}

test('real Go package checks fail then pass, vet runs, and evidence identifies the pinned toolchain', async () => {
  const root = requireGoRoot();
  await preflightOperatorCheck(command);
  const failed = await runOperatorCheck(command, [module, file('sum.go', 'package fixture\nfunc Sum(a,b int)int{return 0}\n'), regression]);
  assert.equal(failed.exitCode, 1, failed.output);
  assert.match(failed.output, /sum regression/);
  const passed = await runOperatorCheck(command, [module, implementation, regression]);
  assert.equal(passed.exitCode, 0, passed.output);
  assert.equal(passed.runtime?.kind, 'go');
  assert.equal(passed.runtime?.version, (await readFile(join(root, 'VERSION'), 'utf8')).split('\n')[0]);
  assert.equal(passed.runtime?.binarySha256, createHash('sha256').update(await readFile(join(root, 'bin/go'))).digest('hex'));
  const vetted = await runOperatorCheck(['go', 'vet', './...'], [module, implementation, regression]);
  assert.equal(vetted.exitCode, 0, vetted.output);
  assert.deepEqual(vetted.runtime, passed.runtime);
});

test('Go command and source validation rejects extra flags, remote imports, traversal and missing module/package scope', () => {
  for (const attempted of [['go', 'run', './...'], ['go', 'test', '-race'], ['go', 'vet', '-vettool=/bin/sh', './...'],
    ['go', 'test', 'example.com/remote'], ['go', 'test', '../escape'], ['go', 'test', './a/../b'], ['go', 'test', '/host'],
    ['go', 'test', './a*']]) {
    assert.throws(() => validateOperatorCheckInput(attempted, [module, implementation, regression]), /operator_check_command_invalid/);
  }
  assert.throws(() => validateOperatorCheckInput(command, [implementation, regression]), /operator_check_go_module_missing/);
  assert.throws(() => validateOperatorCheckInput(['go', 'test', './missing'], [module, implementation]), /operator_check_go_package_missing/);
  assert.doesNotThrow(() => validateOperatorCheckInput(['go', 'test', './nested/...'], [module, file('nested/deep/sum.go', 'package deep')]));
  assert.throws(() => validateOperatorCheckInput(['go', 'test', './nested'], [module, file('nested/deep/sum.go', 'package deep')]),
    /operator_check_go_package_missing/);
});

test('Go configuration must name a canonical absolute trusted root and missing runtime fails before intent', async () => {
  const root = requireGoRoot();
  const fixture = await mkdtemp(join(tmpdir(), 'operator-go-root-'));
  try {
    delete process.env.ONIONSOUP_HOST_GO_ROOT;
    await assert.rejects(preflightOperatorCheck(command), /operator_check_go_runtime_unavailable/);
    process.env.ONIONSOUP_HOST_GO_ROOT = 'relative/toolchain';
    await assert.rejects(preflightOperatorCheck(command), /operator_check_go_runtime_unavailable/);
    await symlink(root, join(fixture, 'linked'));
    process.env.ONIONSOUP_HOST_GO_ROOT = join(fixture, 'linked');
    await assert.rejects(preflightOperatorCheck(command), /operator_check_go_runtime_invalid/);
    process.env.ONIONSOUP_HOST_GO_ROOT = `${root}/../1.25.8`;
    await assert.rejects(preflightOperatorCheck(command), /operator_check_go_runtime_invalid|operator_check_go_runtime_unavailable/);
  } finally {
    process.env.ONIONSOUP_HOST_GO_ROOT = root;
    await rm(fixture, { recursive: true, force: true });
  }
});

test('Go checks cannot read host markers/config, write sources/runtime, inherit Go overrides, invoke shell or reach host network', async () => {
  requireGoRoot();
  const fixture = await mkdtemp(join(tmpdir(), 'operator-go-isolation-'));
  const marker = join(fixture, 'fake-host-secret');
  await writeFile(marker, 'fake only');
  const server = createServer(socket => socket.end('fake only'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const overrides = { GOFLAGS: '-toolexec=/bin/sh', GOROOT: fixture, GOPROXY: 'https://invalid.example',
    GOTOOLCHAIN: 'auto', GOENV: marker, GOWORK: marker, OPERATOR_GO_FAKE_SECRET: 'fake only' };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    const isolation = file('isolation_test.go', `package fixture
import("testing";"os";"os/exec";"net";"time")
func TestIsolation(t *testing.T) {
 for _,path:=range []string{${JSON.stringify(marker)},${JSON.stringify(configuredGoRoot)},"/workspace/.git","/var/home","/home","/etc","/goroot/src/cmd","/goroot/test","/goroot/doc"} {
  if _,err:=os.Stat(path);err==nil {t.Errorf("unexpected host path visible: %s",path)}
 }
 for _,path:=range []string{"/workspace/sum.go","/goroot/src/fmt/print.go","/root-write"} {
  if err:=os.WriteFile(path,[]byte("changed"),0600);err==nil {t.Errorf("write succeeded: %s",path)}
 }
 expected:=map[string]string{"GOROOT":"/goroot","GOTOOLCHAIN":"local","GOPROXY":"off","GOSUMDB":"off","GOWORK":"off","GOENV":"off","CGO_ENABLED":"0","GOFLAGS":"-mod=readonly","GOCACHE":"/tmp/go-cache","GOMODCACHE":"/tmp/go-mod-cache"}
 for key,value:=range expected {if os.Getenv(key)!=value {t.Errorf("unexpected %s",key)}}
 for _,key:=range []string{"OPERATOR_GO_FAKE_SECRET","ONIONSOUP_HOST_GO_ROOT","DBUS_SESSION_BUS_ADDRESS","HTTPS_PROXY"} {if os.Getenv(key)!="" {t.Errorf("host environment %s",key)}}
 if err:=os.WriteFile("/tmp/private",[]byte("allowed"),0600);err!=nil {t.Fatal(err)}
 if err:=exec.Command("/bin/sh","-c","true").Run();err==nil {t.Fatal("shell visible")}
 socket,err:=net.DialTimeout("tcp",${JSON.stringify(`127.0.0.1:${address.port}`)},time.Second)
 if err==nil {socket.Close();t.Fatal("host network reachable")}
}
`);
    const checked = await runOperatorCheck(command, [module, implementation, isolation]);
    assert.equal(checked.exitCode, 0, checked.output);
    assert.equal(await readFile(marker, 'utf8'), 'fake only');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(fixture, { recursive: true, force: true });
  }
});

test('Go checks cannot download dependencies or newer toolchains, and vet failures remain observable', async () => {
  requireGoRoot();
  const dependency = await runOperatorCheck(command, [file('go.mod', module.content.toString() + '\nrequire example.com/missing v1.0.0\n'),
    file('sum.go', 'package fixture\nimport _ "example.com/missing"\n')]);
  assert.notEqual(dependency.exitCode, 0);
  assert.match(dependency.output, /missing go.sum|GOPROXY=off|disabled by GOPROXY/);
  const toolchain = await runOperatorCheck(command, [file('go.mod', 'module example.com/fixture\n\ngo 1.99.0\n'), implementation]);
  assert.notEqual(toolchain.exitCode, 0);
  assert.match(toolchain.output, /GOTOOLCHAIN=local/);
  const vetted = await runOperatorCheck(['go', 'vet', './...'], [module,
    file('sum.go', 'package fixture\nimport "fmt"\nfunc Broken(){fmt.Printf("%d", "wrong")}\n')]);
  assert.notEqual(vetted.exitCode, 0);
  assert.match(vetted.output, /fmt.Printf|format %d/);
});

test('Go timeout returns completed124 only after stopping the isolated build/test processes', async () => {
  requireGoRoot();
  const previous = OPERATOR_CHECK_RUNNER_LIMITS.timeoutMs;
  try {
    OPERATOR_CHECK_RUNNER_LIMITS.timeoutMs = 4_000;
    const checked = await runOperatorCheck(command, [module, implementation,
      file('hang_test.go', 'package fixture\nimport("testing";"time")\nfunc TestHang(t *testing.T){for{time.Sleep(time.Second)}}\n')]);
    assert.equal(checked.exitCode, 124, checked.output);
    assert.match(checked.output, /operator_check_timeout/);
  } finally { OPERATOR_CHECK_RUNNER_LIMITS.timeoutMs = previous; }
});

async function minimalRuntime(root: string) {
  const fixture = await mkdtemp(join(tmpdir(), 'operator-go-invalid-'));
  await mkdir(join(fixture, 'bin'));
  await copyFile(join(root, 'bin/go'), join(fixture, 'bin/go'), constants.COPYFILE_FICLONE);
  await copyFile(join(root, 'VERSION'), join(fixture, 'VERSION'));
  return fixture;
}

test('unsafe toolchain entries fail closed, including symlinks, writable files and FIFO nodes', async () => {
  const root = requireGoRoot();
  const fixture = await minimalRuntime(root);
  try {
    process.env.ONIONSOUP_HOST_GO_ROOT = fixture;
    await chmod(join(fixture, 'bin/go'), 0o777);
    await assert.rejects(preflightOperatorCheck(command), /operator_check_go_runtime_invalid/);
    await rm(join(fixture, 'bin/go'));
    await symlink(join(root, 'bin/go'), join(fixture, 'bin/go'));
    await assert.rejects(preflightOperatorCheck(command), /operator_check_go_runtime_invalid/);
    await rm(join(fixture, 'bin/go'));
    await promisify(execFile)('/usr/bin/mkfifo', [join(fixture, 'bin/go')]);
    await assert.rejects(preflightOperatorCheck(command), /operator_check_go_runtime_invalid/);
  } finally {
    process.env.ONIONSOUP_HOST_GO_ROOT = root;
    await rm(fixture, { recursive: true, force: true });
  }
});

test('runtime traversal has a bounded entry budget, including empty directories', async () => {
  requireGoRoot();
  const previous = OPERATOR_GO_LIMITS.runtimeEntries;
  try {
    OPERATOR_GO_LIMITS.runtimeEntries = 1;
    await assert.rejects(preflightOperatorCheck(command), /operator_check_go_runtime_limit/);
  } finally { OPERATOR_GO_LIMITS.runtimeEntries = previous; }
});

test('replacing a nested runtime path during copy cannot redirect pinned traversal to host files', async context => {
  const root = requireGoRoot();
  const fixture = await mkdtemp(join(tmpdir(), 'operator-go-race-'));
  const staged = join(fixture, 'toolchain');
  const privateDirectory = join(fixture, 'private');
  await mkdir(privateDirectory);
  await writeFile(join(privateDirectory, 'fake-secret'), 'fake only');
  await cp(root, staged, { recursive: true, filter: path => {
    const relative = path.slice(root.length + 1);
    return !relative.startsWith('src/cmd') && !relative.split('/').includes('testdata')
      && !relative.endsWith('_test.go') && !['doc', 'test', 'api', '.git'].includes(relative.split('/')[0]!);
  } });
  const originalCopy = filesystem.copyFile;
  let replaced = false;
  const override = context.mock.method(filesystem, 'copyFile', async (source: string, destination: string, mode?: number) => {
    const selected = source.startsWith('/proc/self/fd/') ? await readlink(source) : source;
    if (!replaced && selected.startsWith(join(staged, 'src/fmt/'))) {
      replaced = true;
      await rename(join(staged, 'src/fmt'), join(staged, 'src/fmt-original'));
      await symlink(privateDirectory, join(staged, 'src/fmt'));
    }
    await originalCopy(source, destination, mode);
  });
  syncBuiltinESMExports();
  try {
    process.env.ONIONSOUP_HOST_GO_ROOT = await realpath(staged);
    const checked = await runOperatorCheck(command, [module, implementation,
      file('pin_test.go', `package fixture\nimport("testing";"os")\nfunc TestPinned(t *testing.T){if _,err:=os.Stat("/goroot/src/fmt/fake-secret");err==nil{t.Fatal("host file leaked")}}\n`)]);
    assert.ok(replaced);
    assert.equal(checked.exitCode, 0, checked.output);
    assert.equal(await readFile(join(privateDirectory, 'fake-secret'), 'utf8'), 'fake only');
  } finally {
    override.mock.restore();
    syncBuiltinESMExports();
    process.env.ONIONSOUP_HOST_GO_ROOT = root;
    await rm(fixture, { recursive: true, force: true });
  }
});
