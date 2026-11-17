import { EmptyState, type EmptyStateProps } from "../ui/empty-state";
import { cn } from "../lib/utils";

/**
 * The shared empty state, sized for a panel inside a settings section: about 120–144px tall instead of a
 * page-level hero. A 36px icon tile with a 20px icon, a 14px title and tighter spacing, inside a dashed border.
 */
const compactEmptyStateClass = [
  "rounded-lg border border-dashed border-border py-6",
  "[&>div:first-child]:mb-3 [&>div:first-child]:size-9 [&>div:first-child]:rounded-md",
  "[&>div:first-child>svg]:size-5",
  "[&>p:first-of-type]:text-sm [&>p:first-of-type]:leading-5",
  "[&>p+p]:mt-1 [&>div:last-child]:mt-3",
].join(" ");

export function SettingsEmptyState({ className, ...props }: EmptyStateProps) {
  return <EmptyState {...props} className={cn(compactEmptyStateClass, className)} />;
}

export default SettingsEmptyState;
