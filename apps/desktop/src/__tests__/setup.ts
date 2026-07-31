import { setCodingAgentsLoggerForTesting } from '@bitsentry-ce/coding-agents/logger'

// Keep fixture diagnostics out of the user's electron-log file while retaining
// a logger injection seam for assertions in individual suites.
setCodingAgentsLoggerForTesting({
  info: () => {},
  warn: () => {},
  error: () => {},
})
