// `package:publish` used to run a full build with `electron-builder --publish always`. CE releases are built, signed
// and uploaded only by the reviewed manual release workflow, so this command now stops before doing anything.
console.error(
  [
    'package:publish no longer builds or publishes BitSentry Desktop CE.',
    'Publish CE releases with the "Desktop CE Release (Manual)" GitHub Actions workflow',
    '(.github/workflows/desktop-ce-release.yml in bitsentry-ai/desktop-ce).',
    'For a local build without publishing, use package, package:mac, package:linux or package:win.',
  ].join('\n'),
);
process.exit(1);
