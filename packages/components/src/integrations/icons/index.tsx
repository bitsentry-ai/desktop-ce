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
