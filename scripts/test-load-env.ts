import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "notion-cron-env-"));
  const envPath = path.join(tempDir, ".env");
  const envLocalPath = path.join(tempDir, ".env.local");

  fs.writeFileSync(envPath, "FROM_ENV=base\nOVERRIDE_TEST=base\n");
  fs.writeFileSync(envLocalPath, "FROM_LOCAL=local\nOVERRIDE_TEST=local\n");

  const originalCwd = process.cwd();
  const originalFromEnv = process.env.FROM_ENV;
  const originalFromLocal = process.env.FROM_LOCAL;
  const originalOverride = process.env.OVERRIDE_TEST;

  process.chdir(tempDir);

  const { loadEnvironment } = await import("../src/load-env");
  loadEnvironment();

  assert.equal(process.env.FROM_ENV, "base");
  assert.equal(process.env.FROM_LOCAL, "local");
  assert.equal(process.env.OVERRIDE_TEST, "local");

  process.chdir(originalCwd);
  process.env.FROM_ENV = originalFromEnv;
  process.env.FROM_LOCAL = originalFromLocal;
  process.env.OVERRIDE_TEST = originalOverride;
  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log("load env checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
