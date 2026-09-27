import { homedir } from 'node:os'
import { join } from 'node:path'

function expandHome(pathValue: string): string {
  if (pathValue === '~') {
    return homedir()
  }
  if (pathValue.startsWith('~/') || pathValue.startsWith('~\\')) {
    return join(homedir(), pathValue.slice(2))
  }
  return pathValue
}

/** Pi agent directory: $PI_CODING_AGENT_DIR or ~/.pi/agent. */
export function getAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['PI_CODING_AGENT_DIR']
  if (override) {
    return expandHome(override)
  }
  return join(homedir(), '.pi', 'agent')
}

/** Session storage directory: $PI_CODING_AGENT_SESSION_DIR or <agentDir>/sessions. */
export function getSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['PI_CODING_AGENT_SESSION_DIR']
  if (override) {
    return expandHome(override)
  }
  return join(getAgentDir(env), 'sessions')
}
