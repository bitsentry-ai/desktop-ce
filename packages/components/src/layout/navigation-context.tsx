import {
  createContext,
  useContext,
  type ReactNode,
} from "react";

export type NavbarSubNavigation = Readonly<Record<string, ReactNode>>;

const NavbarSubNavigationContext = createContext<NavbarSubNavigation>({});

export function NavbarSubNavigationProvider({
  subNavigation,
  children,
}: {
  subNavigation: NavbarSubNavigation;
  children: ReactNode;
}) {
  return (
    <NavbarSubNavigationContext.Provider value={subNavigation}>
      {children}
    </NavbarSubNavigationContext.Provider>
  );
}

export function useNavbarSubNavigation(): NavbarSubNavigation {
  return useContext(NavbarSubNavigationContext);
}
