import { RunbookExternalSourceActionFields } from "./RunbookExternalSourceActionFields";
import { RunbookHttpActionFields } from "./RunbookHttpActionFields";
import { RunbookLlmActionFields } from "./RunbookLlmActionFields";
import { RunbookPluginActionFields } from "./RunbookPluginActionFields";
import { RunbookShellActionFields } from "./RunbookShellActionFields";
import type { RunbookActionTypeFieldsProps } from "./RunbookActionFieldShared";

export function RunbookActionTypeFields({
  action,
  ...props
}: RunbookActionTypeFieldsProps) {
  switch (action.type) {
    case "shell":
      return <RunbookShellActionFields action={action} {...props} />;
    case "llm":
      return <RunbookLlmActionFields action={action} {...props} />;
    case "http":
      return <RunbookHttpActionFields action={action} {...props} />;
    case "plugin":
      return <RunbookPluginActionFields action={action} {...props} />;
    case "external_source":
      return <RunbookExternalSourceActionFields action={action} {...props} />;
    default:
      return null;
  }
}
