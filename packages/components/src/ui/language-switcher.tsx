import * as React from "react";
import {
  LOCALE_DISPLAY,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  useLocale,
  useTranslation,
} from "@bitsentry-ce/i18n";

import { cn } from "../lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";

export interface LanguageSwitcherProps {
  className?: string;
  triggerClassName?: string;
  placeholder?: string;
  showFlag?: boolean;
  showNativeName?: boolean;
}

export function LanguageSwitcher({
  className,
  triggerClassName,
  placeholder,
  showFlag = true,
  showNativeName = true,
}: LanguageSwitcherProps) {
  const { t } = useTranslation();
  const { locale, setLocale } = useLocale();
  const label = placeholder ?? t("common.systemSettings.language");

  const handleChange = React.useCallback(
    (next: string) => {
      if (isSupportedLocale(next)) {
        void setLocale(next);
      }
    },
    [setLocale],
  );

  return (
    <div className={cn("inline-flex", className)}>
      <Select value={locale} onValueChange={handleChange}>
        <SelectTrigger
          className={cn("w-[180px]", triggerClassName)}
          aria-label={label}
        >
          <SelectValue placeholder={label} />
        </SelectTrigger>
        <SelectContent>
          {SUPPORTED_LOCALES.map((code) => {
            const display = LOCALE_DISPLAY[code];
            let displayName = display.label;
            if (showNativeName) {
              displayName = display.nativeName;
            }

            return (
              <SelectItem key={code} value={code}>
                <span className="flex items-center gap-2">
                  {showFlag && <span aria-hidden>{display.flag}</span>}
                  <span>{displayName}</span>
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}
