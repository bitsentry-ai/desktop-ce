import { useState, type KeyboardEvent } from "react";
import { useTranslation } from "@bitsentry-ce/i18n";
import { cn } from "../../lib/utils";

const titleTextClassName = "text-[15px] font-semibold leading-5 tracking-[-0.01em]";

/**
 * The incident title in the page header. A long title wraps to two lines on a narrow screen and keeps one line from
 * 640px; clicking it renames the incident unless it is archived.
 */
export function EditableTitle({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const commit = () => {
    const trimmed = draft.trim() || "New Incident";
    setDraft(trimmed);
    onChange(trimmed);
    setEditing(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      setEditing(false);
    }
  };

  // Archiving closes an open edit.
  if (editing && !disabled) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => { setDraft(e.target.value); }}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        className={cn(
          "w-full min-w-0 border-b border-primary/50 bg-transparent text-foreground outline-none focus:border-primary",
          titleTextClassName,
        )}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        if (!disabled) {
          // Starts from the current title, which may have changed since the last edit.
          setDraft(value);
          setEditing(true);
        }
      }}
      title={t(disabled ? "common.incidents.archivedIncidentsAreReadOnly" : "common.incidents.clickToRename")}
      disabled={disabled}
      className={cn(
        "block w-full min-w-0 text-left text-foreground transition-colors",
        titleTextClassName,
        disabled ? "cursor-default" : "hover:text-muted-foreground",
      )}
    >
      <span className="line-clamp-2 break-words sm:line-clamp-1">{value}</span>
    </button>
  );
}
