import {
  buildPrReview,
  MAX_PR_COMMENTS,
  type PrCommentInput,
  type PrFile
} from '../../shared/pr-review'
import type { PrReviewPosted } from '../../shared/api'
import { gh } from './pr-status'

const GH_TIMEOUT_MS = 30_000
const MAX_TEXT = 4000
const MAX_LINE_TEXT = 20_000
const MAX_PATH = 1000


function validateComments(value: unknown): PrCommentInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PR_COMMENTS) {
    throw new Error(`Post between 1 and ${MAX_PR_COMMENTS} comments`)
  }
  return value.map((item: unknown) => {
    const c = (item ?? {}) as Record<string, unknown>
    const path = typeof c['path'] === 'string' ? c['path'] : ''
    const text = typeof c['text'] === 'string' ? c['text'].trim() : ''
    if (
      !path ||
      path.length > MAX_PATH ||
      path.startsWith('/') ||
      path.split('/').includes('..') ||
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f]/.test(path) ||
      !text
    ) {
      throw new Error('Invalid comment')
    }
    const line = c['line']
    return {
      path,
      ...(typeof line === 'number' && Number.isInteger(line) && line > 0 ? { line } : {}),
      ...(typeof c['lineText'] === 'string' ? { lineText: c['lineText'].slice(0, MAX_LINE_TEXT) } : {}),
      text: text.slice(0, MAX_TEXT),
      ...(c['author'] === 'pi' ? { author: 'pi' as const } : {}),
      ...(c['removed'] === true ? { removed: true } : {})
    }
  })
}

function ghError(run: { err: string; out: string }, what: string): Error {
  const detail = (run.err || run.out).trim().split('\n').slice(-3).join(' ').slice(0, 300)
  return new Error(detail ? `${what}: ${detail}` : what)
}

/**
 * Post diff comments to the pull request of the branch checked out in
 * `cwd`, as one review through the GitHub CLI. With `account` set, gh posts
 * as that signed-in account (a bot account, say); its token goes to gh's
 * own process only and is never kept or logged.
 */
const posting = new Set<string>()

export async function postCommentsToPr(
  cwd: string,
  input: unknown,
  account: string | undefined
): Promise<PrReviewPosted> {
  const comments = validateComments(input)
  // One post per project at a time: a second tap would post twice.
  if (posting.has(cwd)) {
    throw new Error('Already posting these comments')
  }
  posting.add(cwd)
  try {
    return await post(cwd, comments, account)
  } finally {
    posting.delete(cwd)
  }
}

async function post(
  cwd: string,
  comments: PrCommentInput[],
  account: string | undefined
): Promise<PrReviewPosted> {
  const view = await gh(cwd, ['pr', 'view', '--json', 'number,url,headRefOid,state'], GH_TIMEOUT_MS)
  if (view.missing) {
    throw new Error('The GitHub CLI (gh) is not installed')
  }
  if (!view.ok) {
    throw /no pull requests? found/i.test(view.err)
      ? new Error('This branch has no pull request')
      : ghError(view, 'gh could not read the pull request')
  }
  const pr = JSON.parse(view.out) as { number?: number; url?: string; headRefOid?: string; state?: string }
  const where = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(pr.url ?? '')
  if (!where || typeof pr.number !== 'number' || !pr.headRefOid) {
    throw new Error('gh returned an unexpected pull request')
  }
  if (pr.state && pr.state !== 'OPEN') {
    throw new Error(`The pull request is ${pr.state.toLowerCase()}`)
  }
  const [, host, owner, repo] = where
  const api = `repos/${owner}/${repo}/pulls/${pr.number}`

  // Every call goes to the PR's own host (GitHub Enterprise included).
  let env: Record<string, string> = { GH_HOST: host! }
  if (account) {
    const token = await gh(cwd, ['auth', 'token', '--hostname', host!, '--user', account], GH_TIMEOUT_MS)
    if (!token.ok || !token.out.trim()) {
      throw new Error(
        `${account} is not signed in to gh on this computer: run \`gh auth login\` as ${account}, or clear the account in Settings`
      )
    }
    // gh reads GH_TOKEN for github.com and *.ghe.com, GH_ENTERPRISE_TOKEN
    // for an Enterprise Server.
    const cloud = host === 'github.com' || host!.endsWith('.ghe.com')
    env = { ...env, [cloud ? 'GH_TOKEN' : 'GH_ENTERPRISE_TOKEN']: token.out.trim() }
  }

  // Page by page (100 a page; GitHub lists at most 3000 files). Only the
  // files that have a comment matter.
  const wanted = new Set(comments.map((c) => c.path))
  const files: PrFile[] = []
  for (let page = 1; page <= 30; page++) {
    const listed = await gh(cwd, ['api', `${api}/files?per_page=100&page=${page}`], GH_TIMEOUT_MS, {
      env
    })
    if (!listed.ok) {
      throw ghError(listed, 'gh could not list the pull request files')
    }
    const batch = JSON.parse(listed.out) as PrFile[]
    files.push(...batch.filter((file) => wanted.has(file.filename)))
    if (batch.length < 100) {
      break
    }
  }
  const draft = buildPrReview(comments, files)

  const posted = await gh(cwd, ['api', '-X', 'POST', `${api}/reviews`, '--input', '-'], GH_TIMEOUT_MS, {
    env,
    input: JSON.stringify({
      commit_id: pr.headRefOid,
      event: 'COMMENT',
      body: draft.body,
      comments: draft.comments
    })
  })
  if (!posted.ok) {
    throw ghError(posted, 'GitHub refused the review')
  }
  const review = JSON.parse(posted.out) as { html_url?: string; user?: { login?: string } }
  return {
    url: review.html_url ?? pr.url!,
    inline: draft.comments.length,
    listed: comments.length - draft.comments.length,
    account: review.user?.login ?? account ?? ''
  }
}
