import { createCodingAgentsProcessEnv } from './coding-agents-process-env.js'

const CLAUDE_CODE_SUBSCRIPTION_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_UNIX_SOCKET',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
] as const
const CLAUDE_CODE_SUBSCRIPTION_ENV_KEY_SET = new Set<string>(
  CLAUDE_CODE_SUBSCRIPTION_ENV_KEYS,
)

export function createClaudeCodeSubscriptionEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(createCodingAgentsProcessEnv(baseEnv))) {
    if (!CLAUDE_CODE_SUBSCRIPTION_ENV_KEY_SET.has(key)) {
      env[key] = value
    }
  }


  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'bitsentry-superterminal/0.1.0'

  return env
}
