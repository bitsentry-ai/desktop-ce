// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { SidebarRow } from "@bitsentry-ce/components/layout/SidebarRows";

afterEach(() => {
  cleanup();
});

describe("SidebarRow title", () => {
  it("clamps to two lines without a display class that would undo the clamp", () => {
    render(
      <MemoryRouter>
        <SidebarRow to="/a" title="A long record title" active={false} />
      </MemoryRouter>,
    );
    const title = screen.getByText("A long record title");
    expect(title.className).toContain("line-clamp-2");
    expect(title.className.split(" ")).not.toContain("block");
  });
});
