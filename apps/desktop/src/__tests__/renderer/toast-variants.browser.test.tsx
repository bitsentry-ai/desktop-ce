import "@bitsentry-ce/components/desktop/desktop-index.css";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { Toaster, toast } from "@bitsentry-ce/components/ui/sonner";
import { Alert, AlertDescription, AlertTitle } from "@bitsentry-ce/components/ui/alert";

type Rgba = [number, number, number, number];

function parseColor(color: string): Rgba {
  const [r = 0, g = 0, b = 0, a = 1] = (color.match(/[\d.]+/g) ?? []).map(Number);
  return [r, g, b, color.startsWith("rgba") ? a : 1];
}

/** WCAG relative luminance of an opaque color. */
function luminance([r, g, b]: Rgba): number {
  const [lr, lg, lb] = [r, g, b].map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function over(top: Rgba, bottom: Rgba): Rgba {
  const alpha = top[3];
  return [0, 1, 2].map((index) => top[index] * alpha + bottom[index] * (1 - alpha)).concat(1) as Rgba;
}

/** The color behind an element: its own and its ancestors' backgrounds, blended down to the page. */
function backgroundOf(element: Element): Rgba {
  const layers: Rgba[] = [];
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    const color = parseColor(getComputedStyle(node).backgroundColor);
    if (color[3] > 0) layers.push(color);
    if (color[3] === 1) break;
  }
  let result: Rgba = [255, 255, 255, 1];
  if (layers.at(-1)?.[3] !== 1) result = parseColor(getComputedStyle(document.body).backgroundColor);
  for (const layer of layers.reverse()) result = over(layer, result);
  return result;
}

function contrast(element: Element): number {
  const background = backgroundOf(element);
  const foreground = over(parseColor(getComputedStyle(element).color), background);
  const [light, dark] = [luminance(foreground), luminance(background)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const SCREENSHOT_DIR = import.meta.env.VITE_TOAST_SCREENSHOT_DIR as string | undefined;

describe.each(["light", "dark"] as const)("toasts and alerts in %s mode", (theme) => {
  afterEach(() => {
    toast.dismiss();
    cleanup();
    document.documentElement.classList.remove("dark");
  });

  it("keep every title and description at WCAG AA contrast", async () => {
    if (theme === "dark") document.documentElement.classList.add("dark");
    await page.viewport(960, 520);
    render(
      <div style={{ padding: 24, width: 440, display: "grid", gap: 12 }}>
        <Toaster theme={theme} position="top-right" expand visibleToasts={6} />
        <Alert variant="destructive">
          <AlertTitle>Failed to load diagnoses</AlertTitle>
          <AlertDescription>Failed to connect to diagnosis service</AlertDescription>
        </Alert>
        <Alert variant="warning">
          <AlertTitle>Provider not configured</AlertTitle>
          <AlertDescription>Open Settings to add a model provider.</AlertDescription>
        </Alert>
        <Alert>
          <AlertTitle>Managed by WorkOS</AlertTitle>
          <AlertDescription>Roles stay in BitSentry.</AlertDescription>
        </Alert>
      </div>,
    );
    act(() => {
      toast.error("Failed to load providers", { description: "Could not load LLM provider configurations." });
      toast.warning("Runbook paused", { description: "Waiting for approval before the write step." });
      toast.success("Runbook saved", { description: "3 actions, timeout 30m." });
      toast.info("Sync started", { description: "Sentry Sandbox API is syncing." });
      toast("Copied link", { description: "The incident link is on your clipboard." });
    });
    await new Promise((resolve) => setTimeout(resolve, 600));

    const toasts = [...document.querySelectorAll("[data-sonner-toast]")];
    expect(toasts).toHaveLength(5);
    const checks = [
      ...toasts.flatMap((item) => [item.querySelector("[data-title]"), item.querySelector("[data-description]")]),
      ...document.querySelectorAll('[role="alert"] h5, [role="alert"] div'),
    ].filter((element): element is Element => element !== null);
    for (const element of checks) {
      const ratio = contrast(element);
      expect(ratio, `${theme}: "${element.textContent ?? ""}" is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
    // Each typed toast's icon carries its status colour (not the title's), at 3:1 or more for a graphic.
    const typed = new Set(["error", "warning", "success", "info"]);
    for (const item of toasts.filter((toastItem) => typed.has(toastItem.getAttribute("data-type") ?? ""))) {
      const icon = item.querySelector("[data-icon] svg");
      const title = item.querySelector("[data-title]");
      expect(icon, `${theme}: ${item.getAttribute("data-type") ?? ""} toast has an icon`).not.toBeNull();
      if (icon === null || title === null) continue;
      expect(getComputedStyle(icon).color).not.toBe(getComputedStyle(title).color);
      expect(contrast(icon)).toBeGreaterThanOrEqual(3);
    }
    if (SCREENSHOT_DIR !== undefined) {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/toasts-and-alerts_${theme}.png` });
    }
  });
});
