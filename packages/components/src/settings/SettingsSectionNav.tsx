import { useId, type ChangeEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { cn } from "../lib/utils";
import { SELECTION_BAR_CLASS } from "../lib/selectionBar";

export interface SettingsSectionNavItem {
  /** The location hash without `#`, such as `plugins` for `/app-settings#plugins`. */
  id: string;
  label: string;
  icon?: LucideIcon;
}

export interface SettingsSectionNavProps {
  items: readonly SettingsSectionNavItem[];
  activeId: string;
  /** The settings page path the section hashes belong to, such as `/settings`. */
  pathname: string;
  /** Names the navigation for assistive technology. */
  label: string;
  /** Labels the section picker shown below the `md` breakpoint, for assistive technology. */
  selectLabel: string;
  /**
   * The page title, such as "Settings". It is the page's `h1`: a small heading above the list on wide screens and
   * above the section picker on narrow ones, so the page keeps its name when the picker shows only a section.
   */
  heading?: string;
  className?: string;
}

const listLinkClass =
  "flex h-8 items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

const selectClass =
  "h-11 w-full appearance-none rounded-md border border-[hsl(var(--field-border))] bg-background pl-3 pr-9 text-base text-foreground transition-colors hover:border-[hsl(var(--field-border-hover))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

/**
 * Section navigation for a settings page that shows one section at a time. On `md` and wider it is a 208px list on
 * the left; below `md` it is a native picker showing the current section, so nothing scrolls sideways or hides behind
 * the edge and the first field stays close to the top. Both write the section to the location hash, so deep links and
 * other menus stay in sync.
 */
export function SettingsSectionNav({
  items,
  activeId,
  pathname,
  label,
  selectLabel,
  heading,
  className,
}: SettingsSectionNavProps) {
  const navigate = useNavigate();
  const selectId = useId();

  const handleSelectChange = (event: ChangeEvent<HTMLSelectElement>) => {
    void navigate({ pathname, hash: `#${event.target.value}` });
  };

  return (
    <nav
      aria-label={label}
      className={cn("min-[900px]:sticky min-[900px]:top-0 min-[900px]:w-52 min-[900px]:shrink-0 min-[900px]:self-start", className)}
    >
      {heading !== undefined && (
        <h1 className="mb-2 block text-xs font-medium uppercase leading-4 tracking-[0.06em] text-muted-foreground min-[900px]:px-2.5">
          {heading}
        </h1>
      )}
      <div className="min-[900px]:hidden">
        <label htmlFor={selectId} className="sr-only">
          {selectLabel}
        </label>
        <div className="relative">
          <select
            id={selectId}
            value={activeId}
            onChange={handleSelectChange}
            className={selectClass}
          >
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <ChevronDown
            aria-hidden={true}
            className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
        </div>
      </div>

      <div className="hidden min-[900px]:block">
        <ul className="flex flex-col gap-px">
          {items.map((item) => (
            <li key={item.id}>
              <SectionLink item={item} pathname={pathname} selected={item.id === activeId} />
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

function SectionLink({
  item,
  pathname,
  selected,
}: {
  item: SettingsSectionNavItem;
  pathname: string;
  selected: boolean;
}) {
  const Icon = item.icon;
  return (
    <Link
      to={{ pathname, hash: `#${item.id}` }}
      aria-current={selected ? "page" : undefined}
      className={cn(
        listLinkClass,
        selected && cn("bg-[hsl(var(--selection))] font-medium text-foreground hover:bg-[hsl(var(--selection))]", SELECTION_BAR_CLASS),
      )}
    >
      {Icon !== undefined && <Icon size={15} className="shrink-0" />}
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

