export const DEFAULT_TEST_CONCURRENCY = 4;
export const TEST_CONCURRENCY_ENV = "ONIONSOUP_TEST_CONCURRENCY";

function concurrency(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new Error("test_concurrency_invalid");
  }
  return Number(value);
}

export function testArguments(args, environment = process.env) {
  let configured = concurrency(environment[TEST_CONCURRENCY_ENV] ?? DEFAULT_TEST_CONCURRENCY);
  const forwarded = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--test-concurrency") {
      configured = concurrency(args[++index]);
    } else if (argument.startsWith("--test-concurrency=")) {
      configured = concurrency(argument.slice("--test-concurrency=".length));
    } else {
      forwarded.push(argument);
    }
  }
  return ["--conditions=onionsoup-source", "--import", "tsx", "--test",
    `--test-concurrency=${configured}`, ...forwarded];
}
