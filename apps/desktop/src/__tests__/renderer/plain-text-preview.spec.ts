import { describe, expect, it } from "vitest"
import { markdownToPlainText } from "@bitsentry-ce/components/lib/plainText"
import { normalizeIncidentPreview } from "@bitsentry-ce/components/investigation/incidents/incidentNormalize"

describe("markdownToPlainText", () => {
  it("drops emphasis and code markers but keeps their text", () => {
    expect(
      markdownToPlainText("Its stored result is **blocked** (`vendor_fix_pending`)."),
    ).toBe("Its stored result is blocked (vendor_fix_pending).")
  })

  it("flattens headings, tables, lists and links into one line", () => {
    expect(
      markdownToPlainText("## Wazuh snapshot | Taken | Scope |\n|---|---|---|\n- see [the runbook](https://x.test)"),
    ).toBe("Wazuh snapshot · Taken · Scope see the runbook")
  })

  it("drops table rules that arrive on one line", () => {
    expect(markdownToPlainText("Snapshot | Taken | |---|---:| | 003 | 12:00 |")).toBe("Snapshot · Taken · 003 · 12:00")
  })

  it("leaves identifiers with underscores alone", () => {
    expect(markdownToPlainText("snake_case_name and a_b stay")).toBe("snake_case_name and a_b stay")
  })
})

describe("normalizeIncidentPreview", () => {
  it("returns null when nothing readable is left", () => {
    expect(normalizeIncidentPreview("**  **")).toBeNull()
  })
})
