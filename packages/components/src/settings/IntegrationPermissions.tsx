import { useEffect, useState } from "react";
import { useTranslation } from "@bitsentry-ce/i18n";
import type { IntegrationActionMode, IntegrationActionPoliciesPort, IntegrationActionPolicy } from "../services/contracts";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

type Approver = { id: number; name?: string; email?: string };
const key = (suffix: string) => `settings.integrationPermissions.${suffix}`;

export function IntegrationPermissions({ connectionId, service }: { connectionId: string; service?: IntegrationActionPoliciesPort }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!service) return null;
  return <details className="w-full text-sm" onToggle={(event) => { setOpen(event.currentTarget.open); }}>
    <summary className="cursor-pointer py-2 font-medium">{t(key("title"))}</summary>
    {open && <PermissionsTable connectionId={connectionId} service={service} />}
  </details>;
}

function PermissionsTable({ connectionId, service }: { connectionId: string; service: IntegrationActionPoliciesPort }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<IntegrationActionPolicy[]>([]);
  const [users, setUsers] = useState<Approver[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(null);
    void service.list(connectionId).then((result) => { if (active) setRows(result); }, (caught: unknown) => {
      if (active) setError(caught instanceof Error ? caught.message : t(key("loadFailed")));
    }).finally(() => { if (active) setLoading(false); });
    if (service.canEdit && service.listUsers) void service.listUsers().then((result) => { if (active) setUsers(result); }, (caught: unknown) => {
      if (active) setError(caught instanceof Error ? caught.message : t(key("loadFailed")));
    });
    return () => { active = false; };
  }, [connectionId, service, t]);
  return <div className="space-y-3 pb-2">
    <p className="text-muted-foreground">{t(key("help"))}</p>
    {error !== null && <p role="alert" className="text-destructive">{error}</p>}
    {loading ? <p role="status">{t(key("loading"))}</p> : <table className="w-full text-left text-sm">
      <thead><tr className="border-b border-border">
        <th className="px-2 py-2 font-medium text-muted-foreground">{t(key("action"))}</th><th className="px-2 py-2 font-medium text-muted-foreground">{t(key("risk"))}</th><th className="px-2 py-2 font-medium text-muted-foreground">{t(key("mode"))}</th>
      </tr></thead>
      <tbody>{rows.map((row) => <PolicyRow key={`${connectionId}:${row.actionId}`} connectionId={connectionId} row={row} users={users} service={service} />)}</tbody>
    </table>}
  </div>;
}

function PolicyRow({ connectionId, row, users, service }: { connectionId: string; row: IntegrationActionPolicy; users: Approver[]; service: IntegrationActionPoliciesPort }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState(row.mode);
  const [approvers, setApprovers] = useState(row.approverUserIds);
  const [saved, setSaved] = useState({ mode: row.mode, approvers: row.approverUserIds });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modes: IntegrationActionMode[] = row.riskLevel === "read" ? ["allow", "deny"] : ["approve", "restricted", "deny"];
  const locked = !service.canEdit || row.hardDenied;
  const selected = mode === "restricted" ? approvers : [];
  const dirty = mode !== saved.mode || JSON.stringify(selected) !== JSON.stringify(saved.approvers);
  async function save() {
    setBusy(true); setError(null);
    try {
      await service.save({ connectionId, actionId: row.actionId, mode, approverUserIds: selected });
      setSaved({ mode, approvers: selected });
    } catch (caught) { setError(caught instanceof Error ? caught.message : t(key("saveFailed"))); }
    finally { setBusy(false); }
  }
  function toggleApprover(id: number, checked: boolean) {
    setApprovers((old) => checked ? [...old, id] : old.filter((value) => value !== id));
  }
  // Keep stored users visible even if the directory no longer includes them. The server validates every save.
  const choices: Approver[] = [...users, ...approvers.filter((id) => !users.some((user) => user.id === id)).map((id) => ({ id }))];
  return <tr className="border-b border-border">
    <td className="px-2 py-2 align-top"><span className="block">{row.label ?? row.actionId}</span><code className="text-xs text-muted-foreground">{row.actionId}</code></td>
    <td className="px-2 py-2 align-top"><Badge variant="secondary">{t(key(row.riskLevel))}</Badge></td>
    <td className="min-w-56 space-y-2 px-2 py-2 align-top">
      {row.hardDenied ? <span>{t(key("alwaysDenied"))}</span> : <Select value={mode} disabled={locked || busy} onValueChange={(value) => { if (modes.includes(value as IntegrationActionMode)) setMode(value as IntegrationActionMode); }}>
        <SelectTrigger aria-label={t(key("modeFor"), { action: row.label ?? row.actionId })}><SelectValue /></SelectTrigger>
        <SelectContent>{modes.map((value) => <SelectItem key={value} value={value}>{t(key(value))}</SelectItem>)}</SelectContent>
      </Select>}
      {mode === "restricted" && !row.hardDenied && <fieldset disabled={locked || busy} className="max-h-40 space-y-1 overflow-y-auto rounded border p-2">
        <legend className="px-1 text-xs">{t(key("approvers"))}</legend>
        {choices.map((user) => <label key={user.id} className="flex items-center gap-2 text-xs">
          <input type="checkbox" className="accent-primary" checked={approvers.includes(user.id)} disabled={locked || busy} onChange={(event) => { toggleApprover(user.id, event.target.checked); }} />
          {user.name ?? user.email ?? String(user.id)}{user.name && user.email ? ` (${user.email})` : ""}
        </label>)}
      </fieldset>}
      {!locked && <Button size="sm" variant="outline" disabled={busy || !dirty || (mode === "restricted" && !approvers.length)} onClick={() => { void save(); }}>{t(key("save"))}</Button>}
      {error !== null && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </td>
  </tr>;
}
