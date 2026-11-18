// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandPaletteHost,
  CommandPaletteProvider,
  defaultNavigationCommands,
  useCommandPalette,
  type CommandPaletteGroup,
} from "@bitsentry-ce/components/shortcuts";

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "common.shortcuts.commands.goToIncidents": "Go to Incidents",
        "common.shortcuts.commands.goToRunbooks": "Go to Runbooks",
        "common.shortcuts.commands.newIncident": "New incident",
        "common.shortcuts.commands.showShortcuts": "Show keyboard shortcuts",
        "common.shortcuts.paletteTitle": "Command palette",
        "common.shortcuts.title": "Keyboard shortcuts",
      })[key] ?? key,
  }),
}));

function Harness({ navigate, groups }: { navigate: (to: string) => void; groups?: CommandPaletteGroup[] }) {
  const palette = useCommandPalette();
  const commands = defaultNavigationCommands(navigate, {
    togglePalette: palette.togglePalette,
    showShortcuts: palette.openShortcuts,
    newIncident: () => navigate("new"),
  });
  return <CommandPaletteHost commands={commands} groups={groups} />;
}

function renderPalette(groups?: CommandPaletteGroup[]) {
  const navigate = vi.fn();
  render(
    <CommandPaletteProvider>
      <Harness navigate={navigate} groups={groups} />
    </CommandPaletteProvider>,
  );
  return navigate;
}

function press(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
}

afterEach(() => {
  cleanup();
});

describe("CommandPalette", () => {
  it("opens with mod+k, filters, moves with arrows and runs with Enter", () => {
    const navigate = renderPalette();
    // jsdom is not macOS, so mod is Control.
    press("k", { ctrlKey: true });
    const input = screen.getByRole("combobox");

    fireEvent.change(input, { target: { value: "go to" } });
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("Go to Incidents"), expect.stringContaining("Go to Runbooks")]),
    );
    expect(options[0].getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(navigate).toHaveBeenCalledWith("/runbooks");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("does not fire letter shortcuts while typing in the palette", () => {
    const navigate = renderPalette();
    press("k", { ctrlKey: true });
    const input = screen.getByRole("combobox");
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true }));
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("runs g sequences and c outside inputs, and shows dynamic groups", () => {
    const run = vi.fn();
    const navigate = renderPalette([
      { id: "recent", heading: "Recent incidents", items: [{ id: "a", label: "Disk full on db-1", run }] },
    ]);
    press("g");
    press("i");
    expect(navigate).toHaveBeenCalledWith("/incidents");
    press("c");
    expect(navigate).toHaveBeenCalledWith("new");

    press("k", { ctrlKey: true });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "disk" } });
    fireEvent.click(screen.getByRole("option", { name: /Disk full/ }));
    expect(run).toHaveBeenCalled();
  });

  it("opens the shortcuts dialog with ?", () => {
    renderPalette();
    press("?", { shiftKey: true });
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
  });
});
