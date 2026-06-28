import type { ErrorSourceType } from "./desktop-error-sources.types";

type SourceWithPostHogConfig<TSourceType extends ErrorSourceType> = {
  sourceType: TSourceType;
  additionalMetadata?: unknown;
  configuration?: {
    posthogBaseUrl?: unknown;
  };
};

type ProviderFactory<TSourceType extends ErrorSourceType, TProvider> = {
  getProvider(sourceType: TSourceType): TProvider;
  getProviderForSource?: (
    source: SourceWithPostHogConfig<TSourceType>,
  ) => TProvider;
};

function hasWithApiBase<TProvider>(
  provider: TProvider,
): provider is TProvider & {
  withApiBase(baseUrl: string): TProvider;
} {
  if (
    provider === null ||
    provider === undefined ||
    typeof provider !== "object" ||
    Array.isArray(provider)
  ) {
    return false;
  }

  return (
    typeof (provider as { withApiBase?: unknown }).withApiBase === "function"
  );
}

export function getProviderForSource<
  TSourceType extends ErrorSourceType,
  TProvider,
>(
  factory: ProviderFactory<TSourceType, TProvider>,
  source: SourceWithPostHogConfig<TSourceType>,
): TProvider {
  const provider =
    factory.getProviderForSource?.(source) ?? factory.getProvider(source.sourceType);
  if (source.sourceType !== "posthog") {
    return provider;
  }

  const posthogBaseUrl = source.configuration?.posthogBaseUrl;
  if (
    typeof posthogBaseUrl !== "string" ||
    posthogBaseUrl.trim().length === 0
  ) {
    return provider;
  }

  if (!hasWithApiBase(provider)) {
    throw new Error("PostHog provider does not support custom API bases");
  }

  // Let allowlist errors propagate — fail closed.
  return provider.withApiBase(posthogBaseUrl.trim());
}
