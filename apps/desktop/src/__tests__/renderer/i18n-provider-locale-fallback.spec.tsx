// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LOCALE_STORAGE_KEY, useTranslation } from "@bitsentry-ce/i18n";

vi.mock("../../../../../packages/i18n/src/locales/fr-FR/common.json", () => {
  throw new Error("chunk failed to download");
});

function BackLabel() {
  const { t } = useTranslation();
  return <p>{t("common.actions.back")}</p>;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("I18nProvider startup locale", () => {
  it("keeps the fallback while a French start loads, then shows English when the locale fails to download", async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "fr-FR");

    render(
      <I18nProvider fallback={<p>Starting</p>}>
        <BackLabel />
      </I18nProvider>,
    );

    expect(screen.getByText("Starting")).toBeTruthy();
    expect(await screen.findByText("Back")).toBeTruthy();
    expect(screen.queryByText("Starting")).toBeNull();
  });
});
