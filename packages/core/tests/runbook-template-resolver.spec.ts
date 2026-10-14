import { expect, it } from "vitest";
import { TemplateResolver } from "../src/features/runbooks/resolver";

it("keeps Go template keywords literal unless they are declared parameters", () => {
  const command =
    "docker inspect --format '{{.Name}} {{with .State.Health}}{{.Status}}{{else}}none{{end}}' app";
  expect(new TemplateResolver({}).resolve(command)).toMatchObject({
    value: command,
    ok: true,
    missing: [],
  });
  expect(
    new TemplateResolver({ params: { end: "2026-10-14" } }).resolveRequired(
      "report --until {{end}}",
    ),
  ).toBe("report --until 2026-10-14");
});
