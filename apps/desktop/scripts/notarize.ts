/**
 * macOS notarization after-sign hook for electron-builder.
 *
 * Environment variables required:
 *   APPLE_ID            — Apple developer account email
 *   APPLE_APP_PASSWORD  — App-specific password (not your Apple ID password)
 *   APPLE_TEAM_ID       — 10-character Apple Developer Team ID
 *
 * When these env vars are absent the hook silently skips notarization,
 * which is the expected behavior for local development builds.
 */
interface NotarizeContext {
  electronPlatformName: string;
  appOutDir: string;
  packager: {
    appInfo: {
      productFilename: string;
    };
  };
}

const loadNotarize = async (): Promise<
  typeof import('@electron/notarize', { with: { 'resolution-mode': 'import' } })
> => {
  // `@electron/notarize` is ESM-only. This keeps the afterSign hook compatible
  // with our CommonJS-compiled runtime.
  return import('@electron/notarize');
};

export default async function notarizing(context: NotarizeContext) {
  const { electronPlatformName, appOutDir } = context;

  // Only notarize macOS builds
  if (electronPlatformName !== 'darwin') {
    return;
  }

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (
    appleId === undefined ||
    appleId.length === 0 ||
    appleIdPassword === undefined ||
    appleIdPassword.length === 0 ||
    teamId === undefined ||
    teamId.length === 0
  ) {
    console.log(
      '  • Skipping notarization — APPLE_ID / APPLE_APP_PASSWORD / APPLE_TEAM_ID not set',
    );
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`  • Notarizing ${appPath} ...`);

  const { notarize } = await loadNotarize();

  await notarize({
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  });

  console.log('  • Notarization complete');
}
