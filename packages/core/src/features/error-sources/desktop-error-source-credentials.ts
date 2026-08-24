import type { ErrorSource } from "./desktop-error-sources.types";

export interface ErrorSourceCredentials {
  accessToken: string | null;
  refreshToken: string | null;
}

export interface ErrorSourceCredentialsStore {
  get(sourceId: string): Promise<ErrorSourceCredentials>;
  set(sourceId: string, credentials: ErrorSourceCredentials): Promise<void>;
  clear(sourceId: string): Promise<void>;
}

export async function resolveErrorSourceCredentials(
  source: ErrorSource,
  credentialsStore: ErrorSourceCredentialsStore | undefined,
): Promise<ErrorSource> {
  if (credentialsStore === undefined) return source;

  const credentials = await credentialsStore.get(source.id);
  return {
    ...source,
    accessTokenRef: credentials.accessToken,
    refreshTokenRef: credentials.refreshToken,
  };
}
