import {
  createContext,
  useContext,
  type ReactNode,
} from "react";

export type NavbarSubNavigation = Readonly<Record<string, ReactNode>>;

const NavbarSubNavigationContext = createContext<NavbarSubNavigation>({});

export function useNavbarSubNavigation(): NavbarSubNavigation {
  return useContext(NavbarSubNavigationContext);
}
