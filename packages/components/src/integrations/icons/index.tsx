import type { SVGProps } from "react";

export type ProviderIconProps = Omit<SVGProps<SVGSVGElement>, "ref"> & {
  size?: number;
};

function withSize(
  props: ProviderIconProps,
  fallback = 28,
): Omit<SVGProps<SVGSVGElement>, "ref"> {
  const { size, width, height, ...rest } = props;
  return {
    width: width ?? size ?? fallback,
    height: height ?? size ?? fallback,
    ...rest,
  };
}

export function PluginIcon(props: ProviderIconProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...withSize(props)}
    >
      <rect width="32" height="32" rx="7" fill="#111827" />
      <path
        d="M10 8.75a2.25 2.25 0 0 1 2.25-2.25h2.5A2.25 2.25 0 0 1 17 8.75V11h2.25A2.25 2.25 0 0 1 21.5 13.25v2.5A2.25 2.25 0 0 1 19.25 18H17v2.25a2.25 2.25 0 0 1-2.25 2.25h-2.5A2.25 2.25 0 0 1 10 20.25V18H7.75A2.25 2.25 0 0 1 5.5 15.75v-2.5A2.25 2.25 0 0 1 7.75 11H10V8.75Z"
        fill="#F9FAFB"
      />
    </svg>
  );
}

export function SentryIcon(props: ProviderIconProps) {
  return (
    <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...withSize(props)}>
      <rect width="32" height="32" rx="7" fill="#362D59" />
      <g transform="translate(5 7) scale(0.0859)">
        <path
          fill="#fff"
          d="M148.368 12.403a23.935 23.935 0 0 0-41.003 0L73.64 70.165c52.426 26.174 87.05 78.177 90.975 136.642h-23.679c-3.918-50.113-34.061-94.41-79.238-116.448l-31.213 53.97a81.595 81.595 0 0 1 47.307 62.375h-54.38a3.895 3.895 0 0 1-3.178-5.69l15.069-25.626a55.046 55.046 0 0 0-17.221-9.738L3.167 191.277a23.269 23.269 0 0 0 8.662 31.982 23.884 23.884 0 0 0 11.583 3.075h74.471a99.432 99.432 0 0 0-41.003-88.72l11.84-20.5c35.679 24.504 55.754 66.038 52.79 109.22h63.094c2.99-65.43-29.047-127.512-84.107-162.986l23.935-41.002a3.947 3.947 0 0 1 5.382-1.384c2.716 1.486 103.993 178.208 105.89 180.258a3.895 3.895 0 0 1-3.486 5.792h-24.396c.307 6.526.307 13.035 0 19.528h24.499A23.528 23.528 0 0 0 256 202.91a23.015 23.015 0 0 0-3.178-11.685L148.368 12.403Z"
        />
      </g>
    </svg>
  );
}

export function PostHogIcon(props: ProviderIconProps) {
  return (
    <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...withSize(props)}>
      <rect width="32" height="32" rx="7" fill="#fff" />
      <g transform="translate(3 9) scale(0.52)">
        <path fill="#1D4AFF" d="M10.891 17.206a1 1 0 0 1-1.788 0l-.882-1.763a1 1 0 0 1 0-.894l.882-1.763a1 1 0 0 1 1.788 0l.882 1.763a1 1 0 0 1 0 .894l-.882 1.763zm0 9.997a1 1 0 0 1-1.788 0L8.22 25.44a1 1 0 0 1 0-.894l.882-1.763a1 1 0 0 1 1.788 0l.882 1.763a1 1 0 0 1 0 .894l-.882 1.763z" />
        <path fill="#F9BD2B" d="M0 23.408c0-.89 1.077-1.337 1.707-.707l4.583 4.583c.63.63.184 1.708-.707 1.708H1a1 1 0 0 1-1-1v-4.584zm0-4.828a1 1 0 0 0 .293.708l9.411 9.41a1 1 0 0 0 .707.294h5.17c.89 0 1.337-1.077.707-1.707l-14.58-14.58C1.077 12.074 0 12.52 0 13.41v5.17zm0-9.997a1 1 0 0 0 .293.707L19.7 28.7a1 1 0 0 0 .707.293h5.17c.89 0 1.337-1.078.707-1.708L1.707 2.707C1.077 2.077 0 2.523 0 3.414v5.17zm9.997 0a1 1 0 0 0 .293.707l17.994 17.995c.63.63 1.707.183 1.707-.708v-5.169a1 1 0 0 0-.293-.707L11.704 2.707c-.63-.63-1.707-.184-1.707.707v5.17zm11.704-5.876c-.63-.63-1.707-.184-1.707.707v5.17a1 1 0 0 0 .293.706l7.997 7.998c.63.63 1.707.183 1.707-.708v-5.169a1 1 0 0 0-.293-.707l-7.997-7.997z" />
        <path fill="#000" d="m42.525 23.53-9.413-9.412c-.63-.63-1.707-.184-1.707.707v13.167a1 1 0 0 0 1 1h14.58a1 1 0 0 0 1-1v-1.2c0-.552-.449-.993-.997-1.064a7.723 7.723 0 0 1-4.463-2.197zm-6.321 2.263a1.6 1.6 0 1 1 0-3.2 1.6 1.6 0 0 1 0 3.2z" />
        <path fill="#1D4AFF" d="M0 27.992a1 1 0 0 0 1 1h4.583c.891 0 1.337-1.078.707-1.708l-4.583-4.583c-.63-.63-1.707-.184-1.707.707v4.584zm9.997-16.995-8.29-8.29C1.077 2.077 0 2.523 0 3.414v5.17a1 1 0 0 0 .293.706l9.704 9.705v-7.998zm-8.29 1.707c-.63-.63-1.707-.184-1.707.707v5.17a1 1 0 0 0 .293.706l9.704 9.705v-7.998l-8.29-8.29z" />
        <path fill="#F54E00" d="M19.994 11.411a1 1 0 0 0-.293-.707l-7.997-7.997c-.63-.63-1.707-.184-1.707.707v5.17a1 1 0 0 0 .293.706l9.704 9.705V11.41zm-9.997 17.58h5.583c.891 0 1.337-1.077.707-1.707l-6.29-6.29v7.998zm0-17.994v7.583a1 1 0 0 0 .293.708l9.704 9.704v-7.584a1 1 0 0 0-.293-.707l-9.704-9.704z" />
      </g>
    </svg>
  );
}

export function WazuhIcon(props: ProviderIconProps) {
  return (
    <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...withSize(props)}>
      <rect width="200" height="200" rx="32" fill="#3D82F7" />
      <text x="36" y="146" fontFamily="Arial, Helvetica, sans-serif" fontWeight="bold" fontSize="130" fill="white">W</text>
      <circle cx="155" cy="140" r="13" fill="#1a1a2e" />
    </svg>
  );
}

export function GithubIcon(props: ProviderIconProps) {
  return (
    <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...withSize(props)}>
      <rect width="32" height="32" rx="7" fill="#24292F" />
      <g transform="translate(6 6) scale(1.25)">
        <path
          fill="#fff"
          fillRule="evenodd"
          clipRule="evenodd"
          d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
        />
      </g>
    </svg>
  );
}

export type ProviderIconKind = "sentry" | "posthog" | "wazuh" | "github" | "plugin";

export function ProviderIcon({ kind, ...props }: ProviderIconProps & { kind: ProviderIconKind }) {
  if (kind === "sentry") return <SentryIcon {...props} />;
  if (kind === "posthog") return <PostHogIcon {...props} />;
  if (kind === "wazuh") return <WazuhIcon {...props} />;
  if (kind === "github") return <GithubIcon {...props} />;
  return <PluginIcon {...props} />;
}
