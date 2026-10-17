import React, { createContext, useContext } from "react";

import type { BitsentryServicePorts } from "./contracts";

interface BitsentryServicesProviderProps {
  services: BitsentryServicePorts;
  children: React.ReactNode;
  permissions?: ActionPermissions;
}

interface ActionPermissions {
  canOperate: boolean;
  canApprove: boolean;
  operatorTitle?: string;
}

// Local desktop execution has no organization roles; Dashboard supplies its policy.
const localPermissions: ActionPermissions = { canOperate: true, canApprove: true };
const ActionPermissionsContext = createContext<ActionPermissions>(localPermissions);

export const useActionPermissions = () => useContext(ActionPermissionsContext);

const BitsentryServicesContext = createContext<BitsentryServicePorts | null>(
  null,
);

export function BitsentryServicesProvider({
  services,
  children,
  permissions,
}: BitsentryServicesProviderProps) {
  return (
    <BitsentryServicesContext.Provider value={services}>
      <ActionPermissionsContext.Provider value={permissions ?? localPermissions}>
        {children}
      </ActionPermissionsContext.Provider>
    </BitsentryServicesContext.Provider>
  );
}

export function useBitsentryServices(): BitsentryServicePorts {
  const context = useContext(BitsentryServicesContext);

  if (!context) {
    throw new Error(
      "BitsentryServicesProvider is missing. Wrap the app with a service provider implementation.",
    );
  }

  return context;
}
