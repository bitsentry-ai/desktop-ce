import { useToast } from "../hooks/use-toast";
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@bitsentry-ce/components/ui/toast";

export function Toaster() {
  const { toasts, dismiss } = useToast();

  return (
    <ToastProvider>
      {toasts.map(({ id, title, description, action, ...props }) => {
        return (
          <Toast key={id} {...props}>
            <div className="grid min-w-0 flex-1 gap-1 text-left">
              {title !== undefined && (
                <ToastTitle>{title}</ToastTitle>
              )}
              {description !== undefined && (
                <ToastDescription>{description}</ToastDescription>
              )}
            </div>
            {action}
            <ToastClose onClick={() => { dismiss(id); }} />
          </Toast>
        );
      })}
      <ToastViewport />
    </ToastProvider>
  );
}
