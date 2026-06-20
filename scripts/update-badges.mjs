#!/usr/bin/env node
// Regenerates the auto-maintained badge + stats blocks in README.md.
//
// Single source of truth for everything between the BADGES and STATS markers.
// Numbers that drift (test count, coverage, source size) are computed here so
// the README can never go stale: CI runs this on every push to `main` and
// commits the result. Run it locally the same way to preview a change.
//
//   node scripts/update-badges.mjs
//
// Test counts come from the CI JUnit reports (env below) because counting them
// means running the suites; coverage and repo stats are read straight off disk.
//
//   TESTS_BACKEND  backend test count        (default: parse reports/junit.xml)
//   TESTS_WEB      web test count            (default: parse web/reports/junit.xml)
//   COV_BACKEND    backend line coverage %   (default: read coverage-summary.json)
//   COV_WEB        web line coverage %       (default: read web coverage-summary.json)
//
// CI passes all four as job outputs (the runner that rewrites the README never
// runs the suites itself); locally they fall back to the on-disk artifacts.
//
// The repo is private, so shields.io cannot read it directly (dynamic/endpoint
// badges 404 for anonymous traffic). Instead we emit plain static-badge URLs
// whose label text this script keeps current — works regardless of visibility.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RepoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const ReadmePath = join(RepoRoot, 'README.md');

// shields.io flat-square is the de-facto "professional" badge style.
const Shield = 'https://img.shields.io/badge';
const BadgeStyle = 'style=flat-square';

/** Pick a shields colour band from a coverage/quality percentage. */
const pctColor = (pct) =>
  pct >= 90
    ? 'brightgreen'
    : pct >= 80
      ? 'green'
      : pct >= 70
        ? 'yellowgreen'
        : pct >= 60
          ? 'yellow'
          : 'orange';

/** Read total line-coverage % from a vitest json-summary, or null if absent. */
const coveragePct = (relPath) => {
  const p = join(RepoRoot, relPath);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')).total.lines.pct;
};

/** Count <testcase> entries in a JUnit report, or null if the report is absent. */
const junitTestCount = (relPath) => {
  const p = join(RepoRoot, relPath);
  if (!existsSync(p)) return null;
  return (readFileSync(p, 'utf8').match(/<testcase\b/g) ?? []).length;
};

/** Count files matching a predicate under a directory (non-recursive). */
const countFiles = (relDir, test) => {
  const p = join(RepoRoot, relDir);
  if (!existsSync(p)) return 0;
  return readdirSync(p).filter(test).length;
};

/** Source files + lines under src/, via git so build output never leaks in. */
const sourceStats = () => {
  const files = execSync('git ls-files "src/**/*.js"', { cwd: RepoRoot })
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean);
  let lines = 0;
  for (const f of files) lines += readFileSync(join(RepoRoot, f), 'utf8').split('\n').length;
  return { files: files.length, lines };
};

const testsBackend = Number(process.env.TESTS_BACKEND) || junitTestCount('reports/junit.xml');
const testsWeb = Number(process.env.TESTS_WEB) || junitTestCount('web/reports/junit.xml');
const totalTests = (testsBackend ?? 0) + (testsWeb ?? 0);

const covBackend = process.env.COV_BACKEND
  ? Number(process.env.COV_BACKEND)
  : coveragePct('coverage/coverage-summary.json');
const covWeb = process.env.COV_WEB
  ? Number(process.env.COV_WEB)
  : coveragePct('web/coverage/coverage-summary.json');

const adrs = countFiles('docs/adr', (f) => /^\d{4}.*\.md$/.test(f));
const { files: srcFiles, lines: srcLines } = sourceStats();

// shields.io reads `-` as a field separator, so literal dashes must be doubled
// first; then URL-encode so `%`, `>`, spaces, etc. survive as badge text.
const esc = (s) => encodeURIComponent(String(s).replace(/-/g, '--'));

const badge = (label, message, color, extra = '') =>
  `![${label}](${Shield}/${esc(label)}-${esc(message)}-${color}?${BadgeStyle}${extra})`;

// --- BADGES block: CI + dynamic numbers + constant project facts ------------
const badges = [
  `[![CI](https://github.com/givewgun/legion/actions/workflows/ci.yml/badge.svg)](https://github.com/givewgun/legion/actions/workflows/ci.yml)`,
  badge('tests', `${totalTests} passing`, 'brightgreen', '&logo=vitest&logoColor=white'),
  covBackend != null &&
    badge(
      'coverage',
      `${Math.round(covBackend)}%`,
      pctColor(covBackend),
      '&logo=vitest&logoColor=white',
    ),
  badge('node', '>=18', '339933', '&logo=node.js&logoColor=white'),
  badge('dashboard', 'React 18 + Vite', '61DAFB', '&logo=react&logoColor=black'),
  badge('bus', 'NATS', '27AAE1', '&logo=natsdotio&logoColor=white'),
  badge('license', 'CC BY-NC-ND 4.0', 'lightgrey'),
  `[![Code style: Prettier](${Shield}/code_style-prettier-ff69b4?${BadgeStyle}&logo=prettier&logoColor=white)](https://prettier.io)`,
]
  .filter(Boolean)
  .join('\n');

// --- STATS block: a compact "at a glance" table -----------------------------
const fmt = (n) => n.toLocaleString('en-US');
const stats = [
  '| Metric | Value |',
  '| --- | --- |',
  `| 🧪 Tests | **${fmt(totalTests)}** (${fmt(testsBackend ?? 0)} backend · ${fmt(testsWeb ?? 0)} web) |`,
  covBackend != null && `| 📊 Backend coverage | **${covBackend}%** lines |`,
  covWeb != null && `| 📊 Dashboard coverage | **${covWeb}%** lines |`,
  '| 🤖 Agents | **4 voting** + 1 risk constraint |',
  `| 📐 ADRs | **${adrs}** decision records |`,
  `| 📦 Source | **${fmt(srcFiles)}** files · **${fmt(srcLines)}** lines (\`src/\`) |`,
]
  .filter(Boolean)
  .join('\n');

/** Replace the content between `<!-- KEY:START -->` and `<!-- KEY:END -->`. */
const replaceBlock = (text, key, body) => {
  const re = new RegExp(`(<!-- ${key}:START -->)[\\s\\S]*?(<!-- ${key}:END -->)`);
  if (!re.test(text)) throw new Error(`README is missing the ${key} markers`);
  return text.replace(re, `$1\n${body}\n$2`);
};

let readme = readFileSync(ReadmePath, 'utf8');
readme = replaceBlock(readme, 'BADGES', badges);
readme = replaceBlock(readme, 'STATS', stats);
writeFileSync(ReadmePath, readme);

console.log(
  `Badges updated: ${totalTests} tests, backend ${covBackend}% / web ${covWeb}% coverage, ${adrs} ADRs, ${srcFiles} src files.`,
);
