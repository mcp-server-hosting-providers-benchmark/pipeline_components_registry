#!/usr/bin/env node
/**
 * Reads component_verification_contract.json and runs all checks defined there.
 * Produces a structured pass/fail report, prints it to stdout, and pushes it
 * as a JSON file to the data branch of this repository.
 *
 * Usage: node verify.js
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT = JSON.parse(fs.readFileSync(path.join(__dirname, "component_verification_contract.json"), "utf8"));
const REGISTRY_URL = CONTRACT.levels[0].checks[0].url;
const WORKTREE_DIR = path.join(__dirname, ".verify_tmp");

// --- helpers ----------------------------------------------------------------

function pass(id) { return { id, status: "pass" }; }
function fail(id, reason) { return { id, status: "fail", reason }; }

function exec(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf8", ...opts });
}

function fetchJson(url) {
  const raw = exec(`curl -sf "${url}"`);
  return JSON.parse(raw);
}

function httpOk(url) {
  try { exec(`curl -sf "${url}" -o /dev/null`); return true; }
  catch { return false; }
}

// --- level 1 — discoverability ----------------------------------------------

function checkDiscoverability() {
  const results = [];
  let registry = null;

  // registry_url_responds
  try {
    const raw = exec(`curl -sf "${REGISTRY_URL}"`);
    results.push(pass("registry_url_responds"));

    // registry_returns_valid_json
    try {
      registry = JSON.parse(raw);
      if (!Array.isArray(registry)) throw new Error("not an array");
      results.push(pass("registry_returns_valid_json"));
    } catch (e) {
      results.push(fail("registry_returns_valid_json", `response is not a valid JSON array — ${e.message}`));
      registry = null;
    }
  } catch {
    results.push(fail("registry_url_responds", "HTTP request failed or returned non-200 status"));
    results.push(fail("registry_returns_valid_json", "skipped — registry URL did not respond"));
  }

  // component_contract_accessible
  const contractUrl = CONTRACT.levels[0].checks[2].url;
  results.push(httpOk(contractUrl)
    ? pass("component_contract_accessible")
    : fail("component_contract_accessible", "component_contract.json is not publicly accessible"));

  return { results, registry };
}

// --- level 2 — self_reference -----------------------------------------------

function checkSelfReference(registry) {
  const results = [];

  if (!registry) {
    for (const c of CONTRACT.levels[1].checks) {
      results.push(fail(c.id, "skipped — registry could not be read"));
    }
    return results;
  }

  // registry_has_self_entry
  const selfEntry = registry.find((c) => c.name === CONTRACT.component);
  results.push(selfEntry
    ? pass("registry_has_self_entry")
    : fail("registry_has_self_entry", `no entry with name = ${CONTRACT.component} found in the registry`));

  // self_entry_has_output_url
  if (selfEntry?.output_url) {
    results.push(pass("self_entry_has_output_url"));
  } else {
    results.push(fail("self_entry_has_output_url", "output_url field is missing or empty in the self-entry"));
  }

  // self_entry_output_url_matches
  const expectedUrl = CONTRACT.levels[1].checks[2].expected_url;
  if (selfEntry?.output_url === expectedUrl) {
    results.push(pass("self_entry_output_url_matches"));
  } else {
    results.push(fail("self_entry_output_url_matches",
      `expected "${expectedUrl}", got "${selfEntry?.output_url ?? "undefined"}"`));
  }

  // verify_script_present
  const verifyUrl = CONTRACT.levels[1].checks[3].url;
  results.push(httpOk(verifyUrl)
    ? pass("verify_script_present")
    : fail("verify_script_present", "verify.js is not publicly accessible from this repo"));

  return results;
}

// --- level 3 — completeness -------------------------------------------------

function checkCompleteness(registry) {
  const results = [];
  const requiredFields = CONTRACT.levels[2].required_fields;
  const expectedCount = CONTRACT.levels[2].expected_component_count;

  if (!registry) {
    results.push(fail("expected_component_count", "skipped — registry could not be read"));
    results.push(fail("all_entries_have_required_fields", "skipped — registry could not be read"));
    return results;
  }

  // expected_component_count
  results.push(registry.length === expectedCount
    ? pass("expected_component_count")
    : fail("expected_component_count", `expected ${expectedCount} components, got ${registry.length}`));

  // all_entries_have_required_fields — one check per entry
  for (const entry of registry) {
    const missing = requiredFields.filter((f) => !entry[f]);
    results.push(missing.length === 0
      ? pass(`entry_required_fields_${entry.name}`)
      : fail(`entry_required_fields_${entry.name}`, `missing fields: ${missing.join(", ")}`));
  }

  return results;
}

// --- level 4 — repos_accessible ---------------------------------------------

function checkReposAccessible(registry) {
  if (!registry) return [fail("repo_accessible", "skipped — registry could not be read")];

  return registry.map((entry) => {
    const url = `https://api.github.com/repos/${entry.github_repo}`;
    return httpOk(url)
      ? pass(`repo_accessible_${entry.name}`)
      : fail(`repo_accessible_${entry.name}`, `GitHub API returned non-200 for ${entry.github_repo}`);
  });
}

// --- push report to data branch ---------------------------------------------

function pushReport(report) {
  try { exec("git fetch origin data:data", { stdio: "pipe" }); } catch {}

  const dataExists = exec("git branch --list data").trim() !== "";
  if (fs.existsSync(WORKTREE_DIR)) exec(`git worktree remove --force ${WORKTREE_DIR}`);

  if (dataExists) {
    exec(`git worktree add ${WORKTREE_DIR} data`);
  } else {
    const emptyTree = exec("git hash-object -t tree /dev/null").trim();
    const emptyCommit = exec(`git commit-tree ${emptyTree} -m "init: data branch"`).trim();
    exec(`git branch data ${emptyCommit}`);
    exec(`git worktree add ${WORKTREE_DIR} data`);
  }

  const filename = `verify_report_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(path.join(WORKTREE_DIR, filename), JSON.stringify(report, null, 2));
  exec(`git -C ${WORKTREE_DIR} add '*.json'`);
  exec(`git -C ${WORKTREE_DIR} commit -m "verify: ${report.summary.pass}/${report.summary.total} checks passed"`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      exec(`git -C ${WORKTREE_DIR} push origin data`);
      break;
    } catch {
      if (attempt < 3) exec(`git -C ${WORKTREE_DIR} pull --rebase origin data`);
    }
  }

  exec(`git worktree remove --force ${WORKTREE_DIR}`);
  return filename;
}

// --- main -------------------------------------------------------------------

const { results: discoverability, registry } = checkDiscoverability();
const selfReference = checkSelfReference(registry);
const completeness = checkCompleteness(registry);
const reposAccessible = checkReposAccessible(registry);

const allChecks = [...discoverability, ...selfReference, ...completeness, ...reposAccessible];

const summary = {
  pass: allChecks.filter((c) => c.status === "pass").length,
  fail: allChecks.filter((c) => c.status === "fail").length,
  total: allChecks.length,
};

const report = {
  component: CONTRACT.component,
  verified_at: new Date().toISOString(),
  summary,
  checks: allChecks,
};

console.log(`
[verify] ${CONTRACT.component}`);
console.log(`[verify] ${summary.pass}/${summary.total} passed, ${summary.fail} failed
`);
for (const c of allChecks) {
  const icon = c.status === "pass" ? "✓" : "✗";
  const detail = c.reason ? ` — ${c.reason}` : "";
  console.log(`  ${icon} ${c.id}${detail}`);
}

const filename = pushReport(report);
console.log(`
[verify] report pushed → data/${filename}`);

process.exit(summary.fail > 0 ? 1 : 0);
