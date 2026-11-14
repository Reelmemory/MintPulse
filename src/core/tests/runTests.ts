/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * CLI Test Runner for CI/CD (`npm test`)
 */

import { runAutomatedTestSuite } from './testSuite.ts';

async function main() {
  console.log('Running MintPulse Automated Test Suite...\n');
  const summary = await runAutomatedTestSuite();

  for (const res of summary.results) {
    const status = res.passed ? 'PASS' : 'FAIL';
    console.log(`[${status}] (${res.suite}) ${res.name} [${res.durationMs}ms]`);
    console.log(`       -> ${res.assertionDetails}`);
    if (res.error) {
      console.error(`       ERROR: ${res.error}`);
    }
  }

  console.log(
    `\nSummary: ${summary.passed}/${summary.total} passed (${summary.failed} failed) in ${summary.durationMs}ms`
  );

  if (summary.failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
