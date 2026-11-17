import "@bitsentry-ce/components/desktop/desktop-index.css";
import type { ReactNode } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { Button } from "@bitsentry-ce/components/ui/button";
import { Input } from "@bitsentry-ce/components/ui/input";
import { FieldError } from "@bitsentry-ce/components/ui/field-error";
import { SidebarRow, SidebarRunStatus } from "@bitsentry-ce/components/layout/SidebarRows";

// Sidebar rows render router links; a plain anchor is enough to show their states.
vi.mock("react-router-dom", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

// The desktop app does not depend on lucide-react, so the sheet draws its two icons inline.
function Play({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path d="M6 4l14 8-14 8z" fill="currentColor" />
    </svg>
  );
}

function Loader2({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 12a9 9 0 1 1-6.2-8.56" strokeLinecap="round" />
    </svg>
  );
}

const SCREENSHOT_DIR = import.meta.env.VITE_TOAST_SCREENSHOT_DIR as string | undefined;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] items-center gap-4">
      <span className="text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

function Caption({ children }: { children: ReactNode }) {
  return <span className="block pt-1 text-center text-xs text-muted-foreground">{children}</span>;
}

/** Every common control in its visible states, side by side, so the states can be judged from one picture. */
function StatesSheet() {
  return (
    <>
      <div className="w-[880px] space-y-6 bg-background p-6 text-foreground">
        <Row label="Primary">
          <div><Button data-testid="primary"><Play className="fill-current" />Run</Button><Caption>default</Caption></div>
          <div><Button data-testid="primary-hover"><Play className="fill-current" />Run</Button><Caption>hover</Caption></div>
          <div><Button data-testid="primary-focus"><Play className="fill-current" />Run</Button><Caption>keyboard focus</Caption></div>
          <div><Button disabled aria-busy="true"><Loader2 className="animate-spin" />Running</Button><Caption>loading</Caption></div>
          <div><Button disabled><Play className="fill-current" />Run</Button><Caption>disabled</Caption></div>
        </Row>
        <Row label="Secondary">
          <div><Button variant="outline">Export</Button><Caption>default</Caption></div>
          <div><Button variant="outline" data-testid="outline-hover">Export</Button><Caption>hover</Caption></div>
          <div><Button variant="ghost">Try again</Button><Caption>ghost</Caption></div>
          <div><Button variant="outline" disabled>Export</Button><Caption>disabled</Caption></div>
        </Row>
        <Row label="Input">
          <div className="w-44"><Input placeholder="Connection name" /><Caption>empty</Caption></div>
          <div className="w-44"><Input data-testid="input-focus" defaultValue="Production" /><Caption>focus</Caption></div>
          <div className="w-44"><Input data-testid="input-invalid" aria-invalid="true" aria-describedby="bad-json" defaultValue="{ bad json" /><FieldError id="bad-json">Must be valid JSON.</FieldError><Caption>invalid</Caption></div>
          <div className="w-44"><Input disabled defaultValue="Read only" /><Caption>disabled</Caption></div>
        </Row>
        <Row label="Sidebar row">
          <div className="w-56 space-y-1">
            <SidebarRow to="/a" title="Disk pressure triage" active={false} trailing="4h" />
            <SidebarRow to="/b" title="Host health snapshot" active trailing="5h" />
            <SidebarRow to="/c" title="Rotate stuck logs" active={false} live trailing={<SidebarRunStatus state="running" label="Running" />} />
            <Caption>default · selected · running</Caption>
          </div>
        </Row>
      </div>
    </>
  );
}

describe.each(["light", "dark"] as const)("interaction states in %s mode", (theme) => {
  afterEach(() => {
    cleanup();
    document.documentElement.classList.remove("dark");
  });

  it("shows hover, keyboard focus, invalid, loading, disabled and selected distinctly", async () => {
    if (theme === "dark") document.documentElement.classList.add("dark");
    await page.viewport(940, 620);
    const { getByTestId } = render(<StatesSheet />);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

    // Picture 1: a focused text input (green border) beside the empty, invalid and disabled ones.
    const input = getByTestId("input-focus");
    const before = getComputedStyle(input).borderColor;
    await userEvent.click(input);
    await settle();
    expect(document.activeElement).toBe(input);
    expect(getComputedStyle(input).borderColor).not.toBe(before);
    expect(getComputedStyle(getByTestId("input-invalid")).borderColor).not.toBe(before);
    expect(document.querySelector('[aria-current="page"]')).not.toBeNull();
    if (SCREENSHOT_DIR !== undefined) {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/interaction-states_${theme}.png` });
    }

    // Picture 2: keyboard focus on a primary button (reached with Tab) and the pointer over another.
    await userEvent.click(getByTestId("primary"));
    await userEvent.tab();
    await userEvent.tab();
    expect(document.activeElement).toBe(getByTestId("primary-focus"));
    await userEvent.hover(getByTestId("primary-hover"));
    await settle();
    if (SCREENSHOT_DIR !== undefined) {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/interaction-states-keyboard_${theme}.png` });
    }
  });
});
