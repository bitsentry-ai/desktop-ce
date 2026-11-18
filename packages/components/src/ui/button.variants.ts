import { cva } from "class-variance-authority";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-45 [&[aria-busy=true]:disabled]:opacity-100 aria-busy:cursor-progress active:scale-[0.98] [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Disabled (not busy): a neutral fill, so an unavailable action never reads as the brand's call to action.
        default:
          "bg-primary text-primary-foreground shadow-sm hover:bg-[hsl(var(--primary-hover))] active:bg-[hsl(var(--primary-hover))] [&:disabled:not([aria-busy=true])]:bg-muted [&:disabled:not([aria-busy=true])]:text-muted-foreground [&:disabled:not([aria-busy=true])]:opacity-100 [&:disabled:not([aria-busy=true])]:shadow-none",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 active:bg-destructive/80",
        outline:
          "border border-input bg-background shadow-[0_1px_0_hsl(var(--shadow-color)/0.04)] hover:bg-[hsl(var(--secondary-hover))] hover:border-border-hover active:bg-accent",
        secondary:
          "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80 active:bg-secondary/70",
        ghost: "hover:bg-[hsl(var(--secondary-hover))] active:bg-accent",
        link: "text-foreground underline-offset-4 hover:underline",
        accent: "bg-primary text-primary-foreground shadow-sm hover:bg-[hsl(var(--primary-hover))] active:bg-[hsl(var(--primary-hover))]",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-6",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);
