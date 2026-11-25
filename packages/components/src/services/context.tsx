import React, { createContext, useContext } from "react";

import type { BitsentryServicePorts } from "./contracts";

interface BitsentryServicesProviderProps {
  services: BitsentryServicePorts;
  children: React.ReactNode;
  permissions?: ActionPermissions;
}

interface ActionPermissions {
  canOperate: boolean;
  operatorTitle?: string;
  /** Create, edit, delete and approve runbook drafts. Defaults to true. */
  canWriteRunbooks?: boolean;
  writeRunbooksTitle?: string;
  /** Ask the assistant to draft or revise runbooks. Defaults to true. */
  canProposeRunbooks?: boolean;
  proposeRunbooksTitle?: string;
}

// Local desktop execution has no organization roles; Dashboard supplies its policy.
const localPermissions: ActionPermissions = { canOperate: true };
const ActionPermissionsContext = createContext<ActionPermissions>(localPermissions);

export const useActionPermissions = () => useContext(ActionPermissionsContext);

/** Runbook authoring permissions with Desktop's defaults filled in: Desktop has no organization roles. */
export function useRunbookPermissions() {
  const permissions = useContext(ActionPermissionsContext);
  return {
    canWrite: permissions.canWriteRunbooks ?? true,
    writeTitle: permissions.writeRunbooksTitle,
    canPropose: permissions.canProposeRunbooks ?? true,
    proposeTitle: permissions.proposeRunbooksTitle,
  };
}

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
