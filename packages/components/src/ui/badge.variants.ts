import { cva } from "class-variance-authority";

export const badgeVariants = cva(
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium leading-4 transition-colors",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground",
        secondary:
          "border-border bg-muted/70 text-muted-foreground",
        destructive:
          "border-[hsl(var(--destructive)/0.2)] bg-[hsl(var(--destructive)/0.1)] text-[hsl(var(--destructive))]",
        outline: "border-input bg-transparent text-foreground",
        accent:
          "border-[hsl(var(--brand-emphasis-border))] bg-[hsl(var(--brand-emphasis-surface))] text-[hsl(var(--brand-emphasis))]",
        success:
          "border-[hsl(var(--success)/0.18)] bg-[hsl(var(--success)/0.08)] text-[hsl(var(--success))]",
        warning:
          "border-[hsl(var(--warning)/0.2)] bg-[hsl(var(--warning)/0.1)] text-[hsl(var(--warning))]",
        critical:
          "border-[hsl(var(--destructive)/0.2)] bg-[hsl(var(--destructive)/0.08)] text-[hsl(var(--destructive))]",
        info: "border-[hsl(var(--info)/0.2)] bg-[hsl(var(--info)/0.08)] text-[hsl(var(--info))]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);
