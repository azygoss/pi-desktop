#!/usr/bin/env node
// Synthetic stand-in for the GitHub CLI used by e2e runs
// (PI_DESKTOP_GH_COMMAND). Answers `pr view`, `run view --log-failed`,
// `auth token`, and the `api` calls that post a review, with canned data.
// PI_FAKE_GH_STATE: failing (default) | pending | passing | none.
// PI_FAKE_GH_LOG: a file each posted review (and the token it used) is appended to.
import { appendFileSync, readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const state = process.env['PI_FAKE_GH_STATE'] ?? 'failing'

if (args[0] === 'pr' && args[1] === 'view') {
  if (state === 'none') {
    process.stderr.write('no pull requests found for branch "synthetic"\n')
    process.exit(1)
  }
  const test =
    state === 'passing'
      ? { status: 'COMPLETED', conclusion: 'SUCCESS' }
      : state === 'pending'
        ? { status: 'IN_PROGRESS', conclusion: null }
        : { status: 'COMPLETED', conclusion: 'FAILURE' }
  process.stdout.write(
    JSON.stringify({
      number: 42,
      title: 'Synthetic pull request',
      url: 'https://github.com/example/synthetic/pull/42',
      state: 'OPEN',
      isDraft: false,
      headRefOid: 'synthetic-sha-1',
      reviewDecision: 'REVIEW_REQUIRED',
      statusCheckRollup: [
        {
          __typename: 'CheckRun',
          name: 'test',
          ...test,
          detailsUrl: 'https://github.com/example/synthetic/actions/runs/1001/job/1'
        },
        { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }
      ]
    })
  )
  process.exit(0)
}

if (args[0] === 'run' && args[1] === 'view') {
  process.stdout.write(
    'test\tRun tests\t2026-01-01T00:00:00.0000000Z FAIL src/synthetic.test.ts\n' +
      'test\tRun tests\t2026-01-01T00:00:01.0000000Z AssertionError: expected 1 to be 2\n'
  )
  process.exit(0)
}

if (args[0] === 'auth' && args[1] === 'token') {
  const user = args[args.indexOf('--user') + 1]
  if (args.includes('--user') && user !== 'synthetic-bot') {
    process.stderr.write(`no oauth token found for github.com account ${user}\n`)
    process.exit(1)
  }
  process.stdout.write('synthetic-bot-token\n')
  process.exit(0)
}

if (args[0] === 'api' && args.some((a) => /\/pulls\/42\/files/.test(a))) {
  process.stdout.write(
    JSON.stringify([
      {
        filename: 'notes.txt',
        patch: '@@ -1,2 +1,3 @@\n line one\n-line two\n+line two changed\n+line three'
      }
    ])
  )
  process.exit(0)
}

if (args[0] === 'api' && args.some((a) => /\/pulls\/42\/reviews$/.test(a))) {
  const review = JSON.parse(readFileSync(0, 'utf8'))
  const login = process.env['GH_TOKEN'] === 'synthetic-bot-token' ? 'synthetic-bot' : 'synthetic-user'
  if (process.env['PI_FAKE_GH_LOG']) {
    appendFileSync(process.env['PI_FAKE_GH_LOG'], JSON.stringify({ login, review }) + '\n')
  }
  process.stdout.write(
    JSON.stringify({
      html_url: 'https://github.com/example/synthetic/pull/42#pullrequestreview-1',
      user: { login }
    })
  )
  process.exit(0)
}

process.exit(1)
