import { beforeEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({
  moduleLoadMock: vi.fn(),
  initMock: vi.fn(),
  closeMock: vi.fn(),
  captureExceptionMock: vi.fn(),
  captureMessageMock: vi.fn(),
  addBreadcrumbMock: vi.fn(),
  startInactiveSpanMock: vi.fn(),
}));

vi.mock("electron-log", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const importSentryModule = async (releaseChannel = "stable") => {
  vi.resetModules();
  process.env.BITSENTRY_SENTRY_DSN = "https://public@example.invalid/1";
  process.env.BITSENTRY_RELEASE_CHANNEL = releaseChannel;
  globalThis.__BITSENTRY_TEST_LOAD_SENTRY_MAIN__ = () => {
    sentryMocks.moduleLoadMock();
    return Promise.resolve({
      IPCMode: {
        Classic: "classic",
      },
      init: sentryMocks.initMock,
      close: sentryMocks.closeMock,
      captureException: sentryMocks.captureExceptionMock,
      captureMessage: sentryMocks.captureMessageMock,
      addBreadcrumb: sentryMocks.addBreadcrumbMock,
      startInactiveSpan: sentryMocks.startInactiveSpanMock,
      setTag: vi.fn(),
      setContext: vi.fn(),
    });
  };
  return import("@bitsentry-ce/desktop-cli/runtime/desktop-sentry");
};

const EXPECTED_APP_VERSION = process.env.npm_package_version ?? "0.0.0";

const createDb = ({
  primary = null,
}: {
  primary?: string | null;
} = {}) => ({
  setting: {
    findUnique: vi.fn(
      ({ where: { key } }: { where: { key: string } }) => {
        if (key === "telemetry.enabled") {
          if (primary === null) {
            return Promise.resolve(null);
          }

          return Promise.resolve({ key, value: primary });
        }
        return Promise.resolve(null);
      },
    ),
  },
});

describe("desktop Sentry consent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.BITSENTRY_SENTRY_DSN;
    delete process.env.BITSENTRY_RELEASE_CHANNEL;
    delete globalThis.__BITSENTRY_TEST_LOAD_SENTRY_MAIN__;
  });

  it("does not initialize on stable first launch without an opt-in setting", async () => {
    const sentry = await importSentryModule();

    await sentry.initSentryIfEnabled(createDb() as never);

    expect(sentryMocks.moduleLoadMock).not.toHaveBeenCalled();
    expect(sentryMocks.initMock).not.toHaveBeenCalled();
  });

  it("initializes on beta first launch when no preference has been saved yet", async () => {
    const sentry = await importSentryModule("beta");

    await sentry.initSentryIfEnabled(createDb() as never);

    expect(sentryMocks.initMock).toHaveBeenCalledTimes(1);
  });

  it("does not initialize when telemetry was disabled", async () => {
    const sentry = await importSentryModule();

    await sentry.initSentryIfEnabled(createDb({ primary: "false" }) as never);

    expect(sentryMocks.moduleLoadMock).not.toHaveBeenCalled();
    expect(sentryMocks.initMock).not.toHaveBeenCalled();
  });

  it("initializes on beta only when telemetry consent is enabled", async () => {
    const sentry = await importSentryModule("beta");

    await sentry.initSentryIfEnabled(createDb({ primary: "true" }) as never);

    expect(sentryMocks.initMock).toHaveBeenCalledTimes(1);
  });

  it("initializes only after telemetry consent is enabled", async () => {
    const sentry = await importSentryModule();

    await sentry.initSentryIfEnabled(createDb({ primary: "true" }) as never);

    expect(sentryMocks.initMock).toHaveBeenCalledTimes(1);
    expect(sentryMocks.initMock).toHaveBeenCalledWith(
      expect.objectContaining({
        attachScreenshot: false,
        dsn: "https://public@example.invalid/1",
        environment: "desktop-production",
        ipcMode: "classic",
        includeLocalVariables: false,
        profilesSampleRate: 0.1,
        release: `bitsentry-desktop@${EXPECTED_APP_VERSION}`,
        sendDefaultPii: false,
        tracesSampleRate: 0.2,
      }),
    );

    const options = sentryMocks.initMock.mock.calls[0]?.[0] as {
      integrations: (
        defaults: Array<{ name: string }>,
      ) => Array<{ name: string }>;
    };
    expect(
      options.integrations([
        { name: "Console" },
        { name: "ContextLines" },
        { name: "LocalVariables" },
        { name: "LocalVariablesAsync" },
        { name: "Screenshots" },
      ]),
    ).toEqual([{ name: "Console" }]);
  });

  it("swallows sentry init failures so startup can continue", async () => {
    sentryMocks.initMock.mockImplementationOnce(() => {
      throw new Error("boom");
    });

    const sentry = await importSentryModule("beta");

    await expect(
      sentry.initSentryIfEnabled(createDb() as never),
    ).resolves.toBeUndefined();
  });
});
