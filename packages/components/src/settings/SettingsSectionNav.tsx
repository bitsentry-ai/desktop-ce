import { useId, type ChangeEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { cn } from "../lib/utils";

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
  /** Labels the section picker shown below the `md` breakpoint. */
  selectLabel: string;
  /** Optional eyebrow above the list on wide screens. */
  heading?: string;
  className?: string;
}

const listLinkClass =
  "flex h-8 items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

const selectClass =
  "h-11 w-full appearance-none rounded-md border border-input bg-background pl-3 pr-9 text-sm text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

/**
 * Section navigation for a settings page that shows one section at a time. On `md` and wider it is a list on the
 * left; below `md` it is a labelled native picker showing the current section, so nothing scrolls sideways or hides
 * behind the edge. Both write the section to the location hash, so deep links and other menus stay in sync.
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
      className={cn("md:sticky md:top-0 md:w-52 md:shrink-0 md:self-start", className)}
    >
      <div className="md:hidden">
        <label
          htmlFor={selectId}
          className="mb-1.5 block text-[13px] font-medium leading-5 text-muted-foreground"
        >
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

      <div className="hidden md:block">
        {heading !== undefined && (
          <p className="mb-2 px-2.5 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
            {heading}
          </p>
        )}
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
      className={cn(listLinkClass, selected && "bg-accent font-medium text-foreground")}
    >
      {Icon !== undefined && <Icon size={15} className="shrink-0" />}
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

export default SettingsSectionNav;
