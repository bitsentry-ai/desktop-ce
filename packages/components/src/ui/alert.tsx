import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from "lucide-react";

import { cn } from "../lib/utils";

const alertVariants = cva(
  [
    "relative w-full rounded-lg border p-4 text-foreground [&>svg~*]:pl-7 [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:size-4 [&>svg]:text-muted-foreground",
    // The variant's own icon, unless the caller passes one.
    "[&>.bs-alert-icon~*]:pl-7 [&:has(>svg)>.bs-alert-icon]:hidden",
  ].join(" "),
  {
    // Tinted surface plus a status icon; the text stays in the foreground
    // colors so titles and descriptions pass AA on every variant.
    variants: {
      variant: {
        default: "border-border bg-card",
        destructive:
          "border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.06)] [&>.bs-alert-icon]:text-[hsl(var(--destructive-text))] [&>svg]:text-[hsl(var(--destructive-text))]",
        warning:
          "border-[hsl(var(--warning)/0.35)] bg-[hsl(var(--warning)/0.07)] [&>.bs-alert-icon]:text-[hsl(var(--warning-text))] [&>svg]:text-[hsl(var(--warning-text))]",
        success:
          "border-[hsl(var(--success)/0.3)] bg-[hsl(var(--success)/0.06)] [&>.bs-alert-icon]:text-[hsl(var(--success-text))] [&>svg]:text-[hsl(var(--success-text))]",
        info: "border-[hsl(var(--info)/0.3)] bg-[hsl(var(--info)/0.06)] [&>.bs-alert-icon]:text-[hsl(var(--info-text))] [&>svg]:text-[hsl(var(--info-text))]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

/** Each status variant's icon, the same set the toasts use. */
const VARIANT_ICONS: Partial<Record<NonNullable<VariantProps<typeof alertVariants>["variant"]>, LucideIcon>> = {
  destructive: CircleAlert,
  warning: TriangleAlert,
  success: CircleCheck,
  info: Info,
};

const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, children, ...props }, ref) => {
  const Icon = variant === null || variant === undefined ? undefined : VARIANT_ICONS[variant];
  return (
    <div
      ref={ref}
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    >
      {Icon !== undefined && (
        <span aria-hidden="true" className="bs-alert-icon absolute left-4 top-4 flex">
          <Icon className="size-4" />
        </span>
      )}
      {children}
    </div>
  );
});
Alert.displayName = "Alert";

const AlertTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h5
    ref={ref}
    className={cn("mb-1 text-sm font-medium leading-5", className)}
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
