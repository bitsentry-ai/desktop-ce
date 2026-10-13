import type { SettingsRepositoryPort } from "./application/ports/outbound";
import { SettingsUseCasesImpl } from "./application/use-cases";

export type DesktopComposedServices<
  TJobRuntime,
  TExtraServices extends object = Record<never, never>,
> = {
  settingsUseCases: SettingsUseCasesImpl;
  jobRuntime: TJobRuntime;
} & TExtraServices;

export function composeDesktopServices<TJobRuntime>(input: {
  settingsRepository: SettingsRepositoryPort;
  jobRuntime: TJobRuntime;
}): DesktopComposedServices<TJobRuntime>;

export function composeDesktopServices<
  TJobRuntime,
  TExtraServices extends object,
>(input: {
  settingsRepository: SettingsRepositoryPort;
  jobRuntime: TJobRuntime;
  extraServices: TExtraServices;
}): DesktopComposedServices<TJobRuntime, TExtraServices>;

export function composeDesktopServices<
  TJobRuntime,
  TExtraServices extends object,
>(input: {
  settingsRepository: SettingsRepositoryPort;
  jobRuntime: TJobRuntime;
  extraServices?: TExtraServices;
}) {
  const baseServices = {
    settingsUseCases: new SettingsUseCasesImpl(input.settingsRepository),
    jobRuntime: input.jobRuntime,
  };

  if (input.extraServices === undefined) {
    return baseServices;
  }

  return {
    ...baseServices,
    ...input.extraServices,
  };
}
