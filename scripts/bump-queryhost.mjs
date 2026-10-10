// Moves the exact `queryhost` pin to a published release and drafts the bump PR body.
//
// Usage: node scripts/bump-queryhost.mjs [version] [--body <file>]
//
// With no version, the npm `latest` tag is used. The script only moves the pin forward,
// rewrites prose that names the old pin, and writes `from`, `to`, and `changed` to
// GITHUB_OUTPUT when it runs inside GitHub Actions. It never commits or pushes.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/u;
const PUBLISH_WAIT_MS = 5 * 60_000;
const PUBLISH_POLL_MS = 15_000;

function parseArgs(argv) {
  let version;
  let body;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--body") {
      body = argv[(index += 1)];
      if (body === undefined) throw new Error("--body needs a file path.");
    } else if (version === undefined && SEMVER.test(arg)) {
      version = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return { version, body };
}

function compare(left, right) {
  const a = SEMVER.exec(left);
  const b = SEMVER.exec(right);
  if (a === null || b === null) throw new Error(`Not an exact release version: ${left}, ${right}`);
  for (let part = 1; part <= 3; part += 1) {
    const difference = Number(a[part]) - Number(b[part]);
    if (difference !== 0) return difference;
  }
  return 0;
}

function npm(args) {
  return execFileSync("npm", args, { cwd: root, encoding: "utf8" }).trim();
}

function publishedVersion(version) {
  try {
    return npm(["view", `queryhost@${version}`, "version"]);
  } catch {
    return "";
  }
}

// A release workflow can ask for the bump seconds after `npm publish`, before the
// registry serves the version, so a requested version gets a short bounded wait.
async function waitForPublish(version) {
  const deadline = Date.now() + PUBLISH_WAIT_MS;
  while (publishedVersion(version) !== version) {
    if (Date.now() >= deadline) throw new Error(`queryhost@${version} is not on npm.`);
    await new Promise((resolve) => setTimeout(resolve, PUBLISH_POLL_MS));
  }
}

function gameIds() {
  const script =
    'import("queryhost/registry").then((m) => console.log(JSON.stringify(Object.keys(m.GAME_REGISTRY))))';
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: root,
      encoding: "utf8",
    }),
  );
}

function markdownFiles() {
  const top = readdirSync(root).filter((name) => name.endsWith(".md"));
  let docs = [];
  try {
    docs = readdirSync(join(root, "docs"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => join("docs", name));
  } catch {
    // No docs directory.
  }
  return [...top, ...docs];
}

// Only phrases that name the old pin change, so historical versions in prose stay put.
function rewritePinnedProse(from, to) {
  const patterns = [`queryhost@${from}`, `\`queryhost\` ${from}`];
  const changed = [];
  for (const file of markdownFiles()) {
    const path = join(root, file);
    const text = readFileSync(path, "utf8");
    let next = text;
    for (const pattern of patterns) next = next.replaceAll(pattern, pattern.replace(from, to));
    if (next !== text) {
      writeFileSync(path, next);
      changed.push(file);
    }
  }
  return changed;
}

function changelogSections(from, to) {
  const changelog = readFileSync(join(root, "node_modules/queryhost/CHANGELOG.md"), "utf8");
  const sections = [];
  let current;
  for (const line of changelog.split("\n")) {
    const heading = /^## \[(\d+\.\d+\.\d+)\]/u.exec(line);
    if (heading !== null) {
      const version = heading[1];
      current = compare(version, from) > 0 && compare(version, to) <= 0 ? [] : undefined;
      if (current !== undefined) sections.push(current);
    } else if (line.startsWith("## ")) {
      current = undefined;
    }
    if (current !== undefined) current.push(line.replace(/^(#+) /u, "#$1 "));
  }
  return sections.map((lines) => lines.join("\n").trim()).join("\n\n");
}

function pullRequestBody({ from, to, added, prose }) {
  const compareUrl = `https://github.com/xIGBClutchIx/queryhost/compare/v${from}...v${to}`;
  const games =
    added.length === 0
      ? "No new game IDs."
      : `New game IDs: ${added.map((id) => `\`${id}\``).join(", ")}.`;
  return [
    `Before: this service pins \`queryhost@${from}\`.`,
    "",
    `After: it pins \`queryhost@${to}\` from npm. ${games}`,
    "",
    "How: opened by the QueryHost release workflow, which ran `scripts/bump-queryhost.mjs` to move the exact pin, refresh the lockfile" +
      (prose.length === 0 ? "." : `, and update ${prose.map((file) => `\`${file}\``).join(", ")}.`),
    "",
    `**Library changes:** ${compareUrl}`,
    "",
    changelogSections(from, to),
    "",
  ].join("\n");
}

function output(values) {
  const file = process.env["GITHUB_OUTPUT"];
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  if (file !== undefined && file !== "") appendFileSync(file, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
}

const args = parseArgs(process.argv.slice(2));
const manifestPath = join(root, "package.json");
const from = JSON.parse(readFileSync(manifestPath, "utf8")).dependencies.queryhost;
if (!SEMVER.test(from))
  throw new Error(`queryhost must be pinned to an exact version, not ${from}.`);

if (args.version !== undefined) await waitForPublish(args.version);
const to = args.version ?? npm(["view", "queryhost", "version"]);

if (compare(to, from) <= 0) {
  output({ from, to, changed: "false" });
} else {
  const before = new Set(gameIds());
  npm([
    "install",
    "--save-exact",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    `queryhost@${to}`,
  ]);
  const added = gameIds().filter((id) => !before.has(id));
  const prose = rewritePinnedProse(from, to);
  if (args.body !== undefined)
    writeFileSync(args.body, pullRequestBody({ from, to, added, prose }));
  output({ from, to, changed: "true" });
}
