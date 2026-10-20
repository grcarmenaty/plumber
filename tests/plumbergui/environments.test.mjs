// Tests of the Environments tab's commands: reading a project's requirements on Plumber and installing
// them on Plumber or a station. Run with:
//   node --test tests/plumbergui/environments.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { installCommand, listsRequirements, readCommand, shellQuote } from "../../src/plumbergui/static/environments.js";

/** Run a command with /bin/sh in dir, as Plumber and ValveStation do (shell=True) */
function sh(command, dir) {
  return execFileSync("/bin/sh", ["-c", command], { cwd: dir, encoding: "utf8" });
}

test("shellQuote makes one word of anything", () => {
  const dir = mkdtempSync(join(tmpdir(), "env-test-"));
  try {
    for (const text of ["plain", "with space", "it's", "'", "$(touch pwned)", "a\"b`c\\d", ""]) {
      assert.equal(sh(`printf %s ${shellQuote(text)}`, dir), text);
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("readCommand prints requirements.txt, and nothing for a project without one", () => {
  const dir = mkdtempSync(join(tmpdir(), "env-test-"));
  try {
    mkdirSync(join(dir, "projects", "it's here"), { recursive: true });
    mkdirSync(join(dir, "projects", "none"), { recursive: true });
    writeFileSync(join(dir, "projects", "it's here", "requirements.txt"), "pandas==2.2.3\n# a comment\n");
    assert.equal(sh(readCommand("it's here"), dir), "pandas==2.2.3\n# a comment\n");
    assert.equal(sh(readCommand("none"), dir), "");
    assert.equal(sh(readCommand("missing"), dir), "");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("listsRequirements: blank lines and comments are nothing to install", () => {
  assert.equal(listsRequirements(""), false);
  assert.equal(listsRequirements("\n  \n# only comments\r\n   # indented\n"), false);
  assert.equal(listsRequirements("# pinned\nnumpy>=1.26\n"), true);
});

test("installCommand: Plumber installs from the project's own file", () => {
  assert.equal(installCommand("it's", null, "ignored"), "cd projects/'it'\\''s' && python -m pip install -r requirements.txt");
});

test("installCommand: a station gets the lines in a here-document that pip reads as its file", () => {
  const command = installCommand("demo", "lab", "pandas==2.2.3\n--index-url https://pypi.example/simple\nnumpy $HOME `x`");
  assert.equal(command, "python -m pip install -r /dev/stdin <<'PLUMBER_REQUIREMENTS_EOF'\n"
    + "pandas==2.2.3\n--index-url https://pypi.example/simple\nnumpy $HOME `x`\nPLUMBER_REQUIREMENTS_EOF");
  // The shell hands the lines over untouched: no expansion inside a quoted here-document
  const dir = mkdtempSync(join(tmpdir(), "env-test-"));
  try {
    const seen = sh(command.replace("python -m pip install -r /dev/stdin", "cat /dev/stdin"), dir);
    assert.equal(seen, "pandas==2.2.3\n--index-url https://pypi.example/simple\nnumpy $HOME `x`\n");
    const crlf = installCommand("demo", "lab", "pandas==2.2.3\r\nnumpy\r\n");
    assert.equal(sh(crlf.replace("python -m pip install -r /dev/stdin", "cat /dev/stdin"), dir), "pandas==2.2.3\r\nnumpy\r\n");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("installCommand: lines that would end the here-document early are refused", () => {
  assert.equal(installCommand("demo", "lab", "pandas\nPLUMBER_REQUIREMENTS_EOF\nnumpy\n"), null);
  assert.equal(installCommand("demo", "lab", "pandas\r\nPLUMBER_REQUIREMENTS_EOF\r\n"), null);
});
