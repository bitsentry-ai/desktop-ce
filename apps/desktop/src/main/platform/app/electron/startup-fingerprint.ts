export function formatDesktopStartupFingerprint(buildGitSha: string, startedAt: string): string {
  return `[main] startup fingerprint buildGitSha=${buildGitSha} startedAt=${startedAt}`
}
