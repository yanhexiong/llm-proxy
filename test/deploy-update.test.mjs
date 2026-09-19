import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

import { updateDeployment } from "../scripts/update-deploy-template.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "update-deploy-template.mjs");
const SOURCE_COMMIT = "a".repeat(40);
const OLD_SOURCE_COMMIT = "b".repeat(40);
const FAKE_D1_ID = "12345678-1234-4123-8123-123456789abc";
const SECOND_D1_ID = "87654321-4321-4123-8123-abcdef987654";

function git(directory, args, options = {}) {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function initRepo(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  git(directory, ["init", "-q", "-b", "main"]);
  git(directory, ["config", "user.name", "Update test"]);
  git(directory, ["config", "user.email", "update-test@example.invalid"]);
  return directory;
}

function writeRepoFile(directory, path, content) {
  const target = join(directory, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
  return target;
}

function readRepoFile(directory, path) {
  return readFileSync(join(directory, path), "utf8");
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function sourceConfig({ main = "worker.js", noBundle = true, d1Id = FAKE_D1_ID } = {}) {
  return `${JSON.stringify(
    {
      name: "llm-proxy-deploy",
      main,
      no_bundle: noBundle,
      assets: { directory: "./public", binding: "ASSETS" },
      d1_databases: [
        {
          binding: "DB",
          database_name: "llm-proxy",
          database_id: d1Id,
          migrations_dir: "migrations",
        },
      ],
    },
    null,
    2,
  )}\n`;
}

function targetConfig({ main = "./worker.js", d1Id = FAKE_D1_ID } = {}) {
  return `// User-owned configuration; update must preserve these bytes.\n${JSON.stringify(
    {
      name: "my-private-gateway",
      main,
      no_bundle: true,
      assets: { directory: "./public", binding: "ASSETS" },
      d1_databases: [
        {
          binding: "DB",
          database_name: "my-private-db",
          database_id: d1Id,
          migrations_dir: "migrations",
        },
      ],
      routes: [{ pattern: "converter.example.test", custom_domain: true }],
    },
    null,
    2,
  )}\n`;
}

function packageFile(version = "0.1.5") {
  return `${JSON.stringify(
    {
      name: "llm-proxy-deploy",
      version,
      private: true,
      type: "module",
      engines: { node: ">=22" },
      scripts: { deploy: "node deploy.mjs" },
      dependencies: { wrangler: "4.134.0" },
    },
    null,
    2,
  )}\n`;
}

function templateVersion(version = "0.1.5", sourceCommit = SOURCE_COMMIT) {
  return `${JSON.stringify(
    {
      version,
      source_commit: sourceCommit,
      source: "https://github.com/yanhexiong/llm-proxy",
    },
    null,
    2,
  )}\n`;
}

function writeManifest(directory, version, sourceCommit, paths) {
  const entries = paths
    .map((path) => ({ path, sha256: sha256(readRepoFile(directory, path)) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  writeRepoFile(
    directory,
    "update-manifest.json",
    `${JSON.stringify({
      schema_version: 1,
      version,
      source_commit: sourceCommit,
      files: entries,
    }, null, 2)}\n`,
  );
}

function commit(directory, message = "fixture") {
  git(directory, ["add", "--all"]);
  git(directory, ["commit", "-qm", message]);
}

function deployPaths({ includeObsolete = false } = {}) {
  return [
    ".node-version",
    "deploy.mjs",
    "lib/cloudflare-secrets.mjs",
    ...(includeObsolete ? ["lib/obsolete.mjs"] : []),
    "migrations/0001_initial.sql",
    ...(includeObsolete ? [] : ["migrations/0002_add.sql"]),
    "package.json",
    "public/assets/index.js",
    "public/index.html",
    ...(includeObsolete ? ["public/old.js"] : []),
    "template-version.json",
    "update-deploy-template.mjs",
    "worker.js",
  ];
}

function createUpstream({
  version = "0.1.5",
  sourceCommit = SOURCE_COMMIT,
  main = "worker.js",
  noBundle = true,
  d1Id = FAKE_D1_ID,
  includeSecondMigration = true,
  oldMigrationContent = "-- initial schema\n",
  mutateExistingMigration = false,
  includeManifest = true,
} = {}) {
  const directory = initRepo("gateway-update-upstream-");
  writeRepoFile(directory, "wrangler.jsonc", sourceConfig({ main, noBundle, d1Id }));
  writeRepoFile(directory, "worker.js", `export default { fetch() { return new Response("${version}"); } };\n`);
  writeRepoFile(directory, "public/index.html", `<html><body>${version}</body></html>\n`);
  writeRepoFile(directory, "public/assets/index.js", `console.log(${JSON.stringify(version)});\n`);
  writeRepoFile(directory, "lib/cloudflare-secrets.mjs", `export const VERSION = ${JSON.stringify(version)};\n`);
  writeRepoFile(directory, "deploy.mjs", `console.log("deploy ${version}");\n`);
  writeRepoFile(directory, "update-deploy-template.mjs", `export const VERSION = ${JSON.stringify(version)};\n`);
  writeRepoFile(directory, ".node-version", "22\n");
  writeRepoFile(directory, "package.json", packageFile(version));
  writeRepoFile(directory, "template-version.json", templateVersion(version, sourceCommit));
  writeRepoFile(
    directory,
    "migrations/0001_initial.sql",
    mutateExistingMigration ? "-- changed existing schema\n" : oldMigrationContent,
  );
  if (includeSecondMigration) {
    writeRepoFile(directory, "migrations/0002_add.sql", "-- append-only migration\n");
  }
  if (includeManifest) {
    writeManifest(directory, version, sourceCommit, deployPaths({ includeObsolete: false }).filter(
      (path) => includeSecondMigration || path !== "migrations/0002_add.sql",
    ));
  }
  commit(directory, "upstream fixture");
  return directory;
}

function createTarget({
  d1Id = SECOND_D1_ID,
  main = "./worker.js",
  initialMigration = "-- initial schema\n",
  includeManifest = true,
  targetSymlink = false,
  gitignorePath = "",
} = {}) {
  const directory = initRepo("gateway-update-target-");
  const configBytes = targetConfig({ main, d1Id });
  writeRepoFile(directory, "wrangler.jsonc", configBytes);
  writeRepoFile(directory, "worker.js", "export default { fetch() { return new Response(\"old\"); } };\n");
  writeRepoFile(directory, "public/index.html", "<html><body>old</body></html>\n");
  writeRepoFile(directory, "public/assets/index.js", "console.log(\"old\");\n");
  if (targetSymlink) {
    unlinkSync(join(directory, "public/assets/index.js"));
    symlinkSync("../../worker.js", join(directory, "public/assets/index.js"));
  }
  writeRepoFile(directory, "public/old.js", "console.log(\"remove me\");\n");
  writeRepoFile(directory, "public/user-note.txt", "keep this user file\n");
  writeRepoFile(directory, "lib/cloudflare-secrets.mjs", "export const VERSION = \"old\";\n");
  writeRepoFile(directory, "lib/obsolete.mjs", "export const obsolete = true;\n");
  writeRepoFile(directory, "lib/user-local.mjs", "export const userFile = true;\n");
  writeRepoFile(directory, "deploy.mjs", "console.log(\"old deploy\");\n");
  writeRepoFile(directory, "update-deploy-template.mjs", "export const VERSION = \"old\";\n");
  writeRepoFile(directory, ".node-version", "22\n");
  writeRepoFile(directory, "package.json", packageFile("0.1.4"));
  writeRepoFile(directory, "template-version.json", templateVersion("0.1.4", OLD_SOURCE_COMMIT));
  writeRepoFile(directory, "migrations/0001_initial.sql", initialMigration);
  writeRepoFile(directory, "README.md", "# Keep this README\n");
  writeRepoFile(directory, ".dev.vars", "ADMIN_USERNAME=private\nADMIN_PASSWORD=private-password\n");
  writeRepoFile(directory, ".github/workflows/private.yml", "name: private\n");
  if (gitignorePath) writeRepoFile(directory, ".gitignore", `${gitignorePath}\n`);
  if (includeManifest) {
    writeManifest(directory, "0.1.4", OLD_SOURCE_COMMIT, deployPaths({ includeObsolete: true }));
  }
  commit(directory, "target fixture");
  return { directory, configBytes };
}

function snapshotTarget(directory) {
  return {
    status: git(directory, ["status", "--porcelain"]),
    worker: readRepoFile(directory, "worker.js"),
    config: readRepoFile(directory, "wrangler.jsonc"),
    files: git(directory, ["ls-files"]),
  };
}

function assertTargetUnchanged(directory, snapshot) {
  assert.equal(readRepoFile(directory, "worker.js"), snapshot.worker);
  assert.equal(readRepoFile(directory, "wrangler.jsonc"), snapshot.config);
  assert.equal(git(directory, ["status", "--porcelain"]), snapshot.status);
  assert.equal(git(directory, ["ls-files"]), snapshot.files);
}

function cleanup(...directories) {
  directories.forEach((directory) => rmSync(directory, { recursive: true, force: true }));
}

test("updates only manifest-listed deployment assets and preserves user-owned files/config", () => {
  const upstream = createUpstream();
  const targetFixture = createTarget();
  try {
    const { directory: target, configBytes } = targetFixture;
    const result = updateDeployment({ targetDir: target, upstreamDir: upstream });

    assert.equal(result.changed, true);
    assert.equal(result.version, "0.1.5");
    const changed = new Set(result.files);
    for (const path of [
      "worker.js",
      "public/index.html",
      "public/assets/index.js",
      "lib/cloudflare-secrets.mjs",
      "lib/obsolete.mjs",
      "migrations/0002_add.sql",
      "deploy.mjs",
      "package.json",
      "template-version.json",
      "update-deploy-template.mjs",
      "update-manifest.json",
      "public/old.js",
    ]) {
      assert.equal(changed.has(path), true, `missing changed path ${path}`);
    }
    assert.equal(changed.has(".node-version"), false);
    assert.equal(readRepoFile(target, "wrangler.jsonc"), configBytes);
    assert.equal(readRepoFile(target, "README.md"), "# Keep this README\n");
    assert.equal(readRepoFile(target, ".dev.vars"), "ADMIN_USERNAME=private\nADMIN_PASSWORD=private-password\n");
    assert.equal(readRepoFile(target, ".github/workflows/private.yml"), "name: private\n");
    assert.equal(readRepoFile(target, "public/user-note.txt"), "keep this user file\n");
    assert.equal(readRepoFile(target, "lib/user-local.mjs"), "export const userFile = true;\n");
    assert.equal(existsSync(join(target, "public/old.js")), false);
    assert.equal(existsSync(join(target, "lib/obsolete.mjs")), false);
    assert.equal(readRepoFile(target, "migrations/0001_initial.sql"), "-- initial schema\n");
    assert.equal(readRepoFile(target, "migrations/0002_add.sql"), "-- append-only migration\n");
    assert.deepEqual(JSON.parse(readRepoFile(target, "template-version.json")), {
      version: "0.1.5",
      source_commit: SOURCE_COMMIT,
      source: "https://github.com/yanhexiong/llm-proxy",
    });
    const manifest = JSON.parse(readRepoFile(target, "update-manifest.json"));
    assert.equal(manifest.schema_version, 1);
    assert.equal(manifest.version, "0.1.5");
    assert.equal(manifest.source_commit, SOURCE_COMMIT);
    assert.equal(manifest.files.every((entry) => entry.path !== "update-manifest.json"), true);
    for (const entry of manifest.files) {
      assert.equal(entry.sha256, sha256(readRepoFile(target, entry.path)), entry.path);
    }
  } finally {
    cleanup(upstream, targetFixture.directory);
  }
});

test("same version and content is a no-op after the target commits the update", () => {
  const upstream = createUpstream();
  const targetFixture = createTarget();
  try {
    const first = updateDeployment({ targetDir: targetFixture.directory, upstreamDir: upstream });
    assert.equal(first.changed, true);
    commit(targetFixture.directory, "apply update");
    const before = snapshotTarget(targetFixture.directory);
    const second = updateDeployment({ targetDir: targetFixture.directory, upstreamDir: upstream });
    assert.deepEqual(second, { changed: false, version: "0.1.5", files: [] });
    assert.deepEqual(snapshotTarget(targetFixture.directory), before);
  } finally {
    cleanup(upstream, targetFixture.directory);
  }
});

test("rejects a dirty target before writing any deployment asset", () => {
  const upstream = createUpstream();
  const targetFixture = createTarget();
  try {
    const { directory: target } = targetFixture;
    writeRepoFile(target, "README.md", "# User changed this before update\n");
    const before = snapshotTarget(target);
    assert.throws(
      () => updateDeployment({ targetDir: target, upstreamDir: upstream }),
      /dirty|未提交/i,
    );
    assertTargetUnchanged(target, before);
  } finally {
    cleanup(upstream, targetFixture.directory);
  }
});

test("rejects a source main tree, invalid target D1, and invalid source configuration", () => {
  const targetFixture = createTarget();
  const invalidMain = createUpstream({ main: "src/index.ts" });
  const invalidNoBundle = createUpstream({ noBundle: false });
  const invalidD1 = createUpstream();
  try {
    const { directory: target } = targetFixture;
    for (const upstream of [invalidMain, invalidNoBundle]) {
      const before = snapshotTarget(target);
      assert.throws(
        () => updateDeployment({ targetDir: target, upstreamDir: upstream }),
        /worker\.js|main|no_bundle/i,
      );
      assertTargetUnchanged(target, before);
    }

    const invalidTarget = createTarget({ d1Id: "00000000-0000-0000-0000-000000000000" });
    try {
      const before = snapshotTarget(invalidTarget.directory);
      assert.throws(
        () => updateDeployment({ targetDir: invalidTarget.directory, upstreamDir: invalidD1 }),
        /D1|database_id|占位|invalid|无效/i,
      );
      assertTargetUnchanged(invalidTarget.directory, before);
    } finally {
      cleanup(invalidTarget.directory);
    }
  } finally {
    cleanup(targetFixture.directory, invalidMain, invalidNoBundle, invalidD1);
  }
});

test("validates manifest paths, hashes, required files, and symlinks before writing", () => {
  const targetFixture = createTarget();
  const cases = [
    {
      name: "path traversal",
      mutate(directory) {
        const manifest = JSON.parse(readRepoFile(directory, "update-manifest.json"));
        manifest.files.push({ path: "../escape.txt", sha256: "0".repeat(64) });
        writeRepoFile(directory, "update-manifest.json", `${JSON.stringify(manifest)}\n`);
      },
      pattern: /path|路径|traversal|清单/i,
    },
    {
      name: "bad hash",
      mutate(directory) {
        const manifest = JSON.parse(readRepoFile(directory, "update-manifest.json"));
        manifest.files[0].sha256 = "0".repeat(64);
        writeRepoFile(directory, "update-manifest.json", `${JSON.stringify(manifest)}\n`);
      },
      pattern: /sha|hash|校验|清单/i,
    },
    {
      name: "missing required file",
      mutate(directory) {
        unlinkSync(join(directory, "public/index.html"));
        const manifest = JSON.parse(readRepoFile(directory, "update-manifest.json"));
        manifest.files = manifest.files.filter((entry) => entry.path !== "public/index.html");
        writeRepoFile(directory, "update-manifest.json", `${JSON.stringify(manifest)}\n`);
      },
      pattern: /public\/index\.html|required|必需|缺少/i,
    },
    {
      name: "symlink",
      mutate(directory) {
        unlinkSync(join(directory, "public/assets/index.js"));
        symlinkSync("../../worker.js", join(directory, "public/assets/index.js"));
      },
      pattern: /symlink|符号|链接|link/i,
    },
  ];
  try {
    for (const scenario of cases) {
      const upstream = createUpstream();
      try {
        scenario.mutate(upstream);
        const before = snapshotTarget(targetFixture.directory);
        assert.throws(
          () => updateDeployment({ targetDir: targetFixture.directory, upstreamDir: upstream }),
          scenario.pattern,
          scenario.name,
        );
        assertTargetUnchanged(targetFixture.directory, before);
      } finally {
        cleanup(upstream);
      }
    }
  } finally {
    cleanup(targetFixture.directory);
  }
});

test("rejects a target symlink or ignored managed path before writing", () => {
  const upstream = createUpstream();
  const symlinkTarget = createTarget({ targetSymlink: true });
  const ignoredTarget = createTarget({ gitignorePath: "public/assets/index.js" });
  try {
    const symlinkBefore = snapshotTarget(symlinkTarget.directory);
    assert.throws(
      () => updateDeployment({ targetDir: symlinkTarget.directory, upstreamDir: upstream }),
      /symlink|符号|链接/i,
    );
    assertTargetUnchanged(symlinkTarget.directory, symlinkBefore);
    assert.equal(
      lstatSync(join(symlinkTarget.directory, "public/assets/index.js")).isSymbolicLink(),
      true,
    );

    const ignoredBefore = snapshotTarget(ignoredTarget.directory);
    assert.throws(
      () => updateDeployment({ targetDir: ignoredTarget.directory, upstreamDir: upstream }),
      /gitignore|排除|ignored/i,
    );
    assertTargetUnchanged(ignoredTarget.directory, ignoredBefore);
  } finally {
    cleanup(upstream, symlinkTarget.directory, ignoredTarget.directory);
  }
});

test("rejects version downgrade and manifest/template metadata mismatch before writing", () => {
  const downgrade = createUpstream({ version: "0.1.3", sourceCommit: "c".repeat(40) });
  const mismatch = createUpstream();
  const downgradeTarget = createTarget();
  const mismatchTarget = createTarget();
  try {
    const downgradeBefore = snapshotTarget(downgradeTarget.directory);
    assert.throws(
      () => updateDeployment({ targetDir: downgradeTarget.directory, upstreamDir: downgrade }),
      /降级|older|version/i,
    );
    assertTargetUnchanged(downgradeTarget.directory, downgradeBefore);

    const manifest = JSON.parse(readRepoFile(mismatch, "update-manifest.json"));
    manifest.version = "0.1.6";
    writeRepoFile(mismatch, "update-manifest.json", `${JSON.stringify(manifest)}\n`);
    const mismatchBefore = snapshotTarget(mismatchTarget.directory);
    assert.throws(
      () => updateDeployment({ targetDir: mismatchTarget.directory, upstreamDir: mismatch }),
      /版本|version|manifest|清单/i,
    );
    assertTargetUnchanged(mismatchTarget.directory, mismatchBefore);
  } finally {
    cleanup(downgrade, mismatch, downgradeTarget.directory, mismatchTarget.directory);
  }
});

test("allows append-only migrations but rejects changed or removed existing migrations", () => {
  const validUpstream = createUpstream();
  const changedUpstream = createUpstream({ mutateExistingMigration: true });
  const removedUpstream = createUpstream({ includeSecondMigration: false });
  const targetFixture = createTarget();
  try {
    const result = updateDeployment({ targetDir: targetFixture.directory, upstreamDir: validUpstream });
    assert.equal(result.changed, true);
  } finally {
    cleanup(validUpstream, targetFixture.directory);
  }

  const changedTarget = createTarget();
  try {
    const before = snapshotTarget(changedTarget.directory);
    assert.throws(
      () => updateDeployment({ targetDir: changedTarget.directory, upstreamDir: changedUpstream }),
      /migration|迁移|修改|changed/i,
    );
    assertTargetUnchanged(changedTarget.directory, before);
  } finally {
    cleanup(changedTarget.directory);
  }

  const removedTarget = createTarget();
  try {
    writeRepoFile(removedTarget.directory, "migrations/0002_add.sql", "-- target-only migration\n");
    const oldManifest = JSON.parse(readRepoFile(removedTarget.directory, "update-manifest.json"));
    oldManifest.files.push({
      path: "migrations/0002_add.sql",
      sha256: sha256(readRepoFile(removedTarget.directory, "migrations/0002_add.sql")),
    });
    writeRepoFile(removedTarget.directory, "update-manifest.json", `${JSON.stringify(oldManifest)}\n`);
    commit(removedTarget.directory, "add target migration");
    const before = snapshotTarget(removedTarget.directory);
    assert.throws(
      () => updateDeployment({ targetDir: removedTarget.directory, upstreamDir: removedUpstream }),
      /migration|迁移|删除|remove/i,
    );
    assertTargetUnchanged(removedTarget.directory, before);
  } finally {
    cleanup(removedTarget.directory);
  }
  cleanup(changedUpstream, removedUpstream);
});

test("protects existing SQL migrations even when the target predates update-manifest.json", () => {
  const validUpstream = createUpstream();
  const changedUpstream = createUpstream({ mutateExistingMigration: true });
  const validTarget = createTarget({ includeManifest: false });
  const changedTarget = createTarget({ includeManifest: false });
  try {
    const result = updateDeployment({ targetDir: validTarget.directory, upstreamDir: validUpstream });
    assert.equal(result.changed, true);
    assert.equal(existsSync(join(validTarget.directory, "update-manifest.json")), true);

    const before = snapshotTarget(changedTarget.directory);
    assert.throws(
      () => updateDeployment({ targetDir: changedTarget.directory, upstreamDir: changedUpstream }),
      /migration|迁移|修改|changed/i,
    );
    assertTargetUnchanged(changedTarget.directory, before);
  } finally {
    cleanup(validUpstream, changedUpstream, validTarget.directory, changedTarget.directory);
  }
});

test("CLI --commit records the update without changing the target configuration", () => {
  const upstream = createUpstream();
  const targetFixture = createTarget();
  try {
    const { directory: target, configBytes } = targetFixture;
    const before = git(target, ["rev-parse", "HEAD"]);
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "--target", target, "--upstream", upstream, "--commit"],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.notEqual(git(target, ["rev-parse", "HEAD"]), before);
    assert.equal(git(target, ["status", "--porcelain"]), "");
    assert.equal(readRepoFile(target, "wrangler.jsonc"), configBytes);
    assert.match(git(target, ["log", "-1", "--pretty=%s"]), /update|deploy|template/i);
  } finally {
    cleanup(upstream, targetFixture.directory);
  }
});

test("a committed CLI update can be pushed to a local bare remote without force", () => {
  const upstream = createUpstream();
  const targetFixture = createTarget();
  const remote = mkdtempSync(join(tmpdir(), "gateway-update-remote-"));
  try {
    git(remote, ["init", "--bare", "-q"]);
    git(targetFixture.directory, ["remote", "add", "origin", remote]);
    git(targetFixture.directory, ["push", "-q", "-u", "origin", "main"]);
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "--target", targetFixture.directory, "--upstream", upstream, "--commit"],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    git(targetFixture.directory, ["push", "-q", "origin", "main"]);
    assert.equal(
      git(remote, ["show-ref", "refs/heads/main"]).split(" ")[0],
      git(targetFixture.directory, ["rev-parse", "HEAD"]),
    );
  } finally {
    cleanup(upstream, targetFixture.directory, remote);
  }
});

test("does not force-push over a concurrent commit already present on the remote", () => {
  const upstream = createUpstream();
  const targetFixture = createTarget();
  const remote = mkdtempSync(join(tmpdir(), "gateway-update-concurrent-remote-"));
  const competitor = mkdtempSync(join(tmpdir(), "gateway-update-competitor-"));
  try {
    git(remote, ["init", "--bare", "-q"]);
    git(targetFixture.directory, ["remote", "add", "origin", remote]);
    git(targetFixture.directory, ["push", "-q", "-u", "origin", "main"]);

    git(competitor, ["clone", "-q", "-b", "main", remote, "."]);
    git(competitor, ["config", "user.name", "Concurrent writer"]);
    git(competitor, ["config", "user.email", "concurrent@example.invalid"]);
    writeRepoFile(competitor, "README.md", "# Concurrent remote edit\n");
    commit(competitor, "concurrent remote edit");
    git(competitor, ["push", "-q", "origin", "main"]);
    const remoteHead = git(remote, ["show-ref", "refs/heads/main"]).split(" ")[0];

    const result = spawnSync(
      process.execPath,
      [SCRIPT, "--target", targetFixture.directory, "--upstream", upstream, "--commit"],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const push = spawnSync("git", ["push", "origin", "main"], {
      cwd: targetFixture.directory,
      encoding: "utf8",
    });
    assert.notEqual(push.status, 0, `${push.stdout}\n${push.stderr}`);
    assert.match(`${push.stdout}\n${push.stderr}`, /rejected|non-fast-forward|fetch first/i);
    assert.equal(git(remote, ["show-ref", "refs/heads/main"]).split(" ")[0], remoteHead);
    assert.notEqual(git(targetFixture.directory, ["rev-parse", "HEAD"]), remoteHead);
  } finally {
    cleanup(upstream, targetFixture.directory, remote, competitor);
  }
});
