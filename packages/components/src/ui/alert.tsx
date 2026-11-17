import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils";

const alertVariants = cva(
  "relative w-full rounded-lg border p-4 text-foreground [&>svg~*]:pl-7 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:size-4 [&>svg]:text-muted-foreground",
  {
    // Tinted surface plus a status icon; the text stays in the foreground
    // colors so titles and descriptions pass AA on every variant.
    variants: {
      variant: {
        default: "border-border bg-card",
        destructive:
          "border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.06)] [&>svg]:text-[hsl(var(--destructive-text))]",
        warning:
          "border-[hsl(var(--warning)/0.35)] bg-[hsl(var(--warning)/0.07)] [&>svg]:text-[hsl(var(--warning-text))]",
        success:
          "border-[hsl(var(--success)/0.3)] bg-[hsl(var(--success)/0.06)] [&>svg]:text-[hsl(var(--success-text))]",
        info: "border-[hsl(var(--info)/0.3)] bg-[hsl(var(--info)/0.06)] [&>svg]:text-[hsl(var(--info-text))]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, ...props }, ref) => (
  <div
    ref={ref}
    role="alert"
    className={cn(alertVariants({ variant }), className)}
    {...props}
  />
));
Alert.displayName = "Alert";

const AlertTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h5
    ref={ref}
    className={cn("mb-1 font-medium leading-none tracking-tight", className)}
    {...props}
  />
));
AlertTitle.displayName = "AlertTitle";

const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm text-muted-foreground [&_p]:leading-relaxed", className)}
    {...props}
  />
));
AlertDescription.displayName = "AlertDescription";

export { Alert, AlertTitle, AlertDescription };
