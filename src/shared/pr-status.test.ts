import { describe, expect, it } from 'vitest'

import { fixChecksPrompt, parsePrView, summarizeChecks } from './pr-status'

const view = JSON.stringify({
  number: 12,
  title: 'Add a thing',
  url: 'https://github.com/example/repo/pull/12',
  state: 'OPEN',
  isDraft: false,
  headRefOid: 'abc123',
  reviewDecision: 'REVIEW_REQUIRED',
  statusCheckRollup: [
    {
      __typename: 'CheckRun',
      name: 'test',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      detailsUrl: 'https://github.com/example/repo/actions/runs/987/job/1'
    },
    { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: null },
    { __typename: 'CheckRun', name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
    { __typename: 'StatusContext', context: 'deploy/preview', state: 'SUCCESS', targetUrl: 'javascript:alert(1)' }
  ]
})

describe('parsePrView', () => {
  it('reads the PR and normalizes both kinds of checks', () => {
    const pr = parsePrView(view)!
    expect(pr).toMatchObject({ number: 12, state: 'OPEN', draft: false, headSha: 'abc123' })
    expect(pr.checks).toEqual([
      {
        name: 'test',
        state: 'fail',
        url: 'https://github.com/example/repo/actions/runs/987/job/1',
        runId: '987'
      },
      { name: 'lint', state: 'pass' },
      { name: 'build', state: 'pending' },
      { name: 'docs', state: 'skipped' },
      { name: 'deploy/preview', state: 'pass' } // non-https URL dropped
    ])
  })

  it('returns null for anything that is not a PR', () => {
    expect(parsePrView('no pull requests found')).toBeNull()
    expect(parsePrView('{}')).toBeNull()
  })
})

describe('summarizeChecks', () => {
  it('lets a failure outrank pending, and pending outrank passing', () => {
    const pr = parsePrView(view)!
    expect(summarizeChecks(pr.checks)).toBe('failing')
    expect(summarizeChecks(pr.checks.filter((c) => c.state !== 'fail'))).toBe('pending')
    expect(summarizeChecks([{ name: 'a', state: 'pass' }, { name: 'b', state: 'skipped' }])).toBe('passing')
    expect(summarizeChecks([])).toBe('none')
  })
})

describe('fixChecksPrompt', () => {
  it('names the failing checks and fences the log', () => {
    const prompt = fixChecksPrompt(parsePrView(view)!, 'Error: boom\n```\nnested')
    expect(prompt).toContain('pull request #12 (Add a thing). Failing check: test.')
    expect(prompt).toContain('````\nError: boom')
    expect(prompt.trimEnd().endsWith('Do not push.')).toBe(true)
  })

  it('works without a log', () => {
    expect(fixChecksPrompt(parsePrView(view)!, '  ')).not.toContain('log')
  })
})
