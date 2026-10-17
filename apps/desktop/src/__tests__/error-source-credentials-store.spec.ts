import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
}));

import { ErrorSourceCredentialsStore } from "../main/platform/app/electron/error-source-credentials-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe("ErrorSourceCredentialsStore", () => {
  it("serializes concurrent credential writes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bitsentry-error-source-"));
    temporaryDirectories.push(directory);
    const credentialsStore = new ErrorSourceCredentialsStore(directory);

    await Promise.all([
      credentialsStore.set("source-1", {
        accessToken: "access-1",
        refreshToken: null,
      }),
      credentialsStore.set("source-2", {
        accessToken: "access-2",
        refreshToken: null,
      }),
    ]);

    await expect(credentialsStore.get("source-1")).resolves.toEqual({
      accessToken: "access-1",
      refreshToken: null,
    });
    await expect(credentialsStore.get("source-2")).resolves.toEqual({
      accessToken: "access-2",
      refreshToken: null,
    });
  });

});
