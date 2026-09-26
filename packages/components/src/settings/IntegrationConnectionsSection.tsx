import { itopTicketMappingSchema } from "@bitsentry-ce/core/features/plugins";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "@bitsentry-ce/i18n";
import type { IntegrationConnection, IntegrationConnectionInput } from "@bitsentry-ce/core/features/plugins";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export interface IntegrationConnectionsPort {
  list(): Promise<IntegrationConnection[]>;
  save(input: IntegrationConnectionInput): Promise<unknown>;
  remove(id: string): Promise<unknown>;
}

export function IntegrationConnectionsSection({ service }: { service: IntegrationConnectionsPort }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<IntegrationConnection[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pluginId, setPluginId] = useState<"itop" | "outline">("itop");
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [ticketMappingText, setTicketMappingText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void service.list().then((result) => { if (active) setRows(result); }, () => {
      if (active) setError(t("settings.integrationConnections.loadFailed"));
    });
    return () => { active = false; };
  }, [service, t]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await service.save({
        id: editingId ?? crypto.randomUUID(), name, pluginId, enabled: true,
        ticketMapping: pluginId === "itop" && ticketMappingText.trim() ? itopTicketMappingSchema.parse(JSON.parse(ticketMappingText)) : undefined,
        auth: pluginId === "itop" ? { baseUrl: endpoint, authToken: token } : { apiBase: endpoint, accessToken: token },
      });
      setToken(""); setName(""); setEndpoint(""); setEditingId(null); setTicketMappingText("");
      setRows(await service.list());
    } catch { setError(t("settings.integrationConnections.saveFailed")); }
    finally { setBusy(false); }
  }

  async function remove(id: string) {
    if (busy) return;
    setBusy(true); setError(null);
    try { await service.remove(id); setRows(await service.list()); }
    catch { setError(t("settings.integrationConnections.removeFailed")); }
    finally { setBusy(false); }
  }

  return <section className="mb-6 space-y-4 rounded-md border border-border p-6">
    <h2 className="text-lg font-medium">{t("settings.integrationConnections.title")}</h2>
    <p className="text-sm text-muted-foreground">{t("settings.integrationConnections.description")}</p>
    {error !== null && <p role="alert" className="text-destructive">{error}</p>}
    <ul className="space-y-2">{rows.map((row) => <li key={row.id} className="flex items-center gap-3">
      <span className="min-w-0 flex-1 break-all">{row.name} — {row.target}<span className="block text-xs text-muted-foreground">{t(`settings.integrationConnections.availability.${row.availability}`)}</span></span>
      <Button disabled={busy} variant="outline" onClick={() => {
        setEditingId(row.id); setTicketMappingText(row.ticketMapping ? JSON.stringify(row.ticketMapping, null, 2) : ""); setName(row.name); setPluginId(row.pluginId); setEndpoint(row.target); setToken("");
      }}>{t("settings.integrationConnections.edit")}</Button>
      <Button disabled={busy} variant="outline" onClick={() => { void remove(row.id); }}>{t("settings.integrationConnections.remove")}</Button>
    </li>)}</ul>
    <p className="text-sm text-muted-foreground">{t("settings.integrationConnections.targetImmutable")}</p>
    <form onSubmit={(event) => { void save(event); }} className="grid gap-3">
      <label>{t("settings.integrationConnections.plugin")}
        <select value={pluginId} disabled={busy || editingId !== null} onChange={(event) => {
          setPluginId(event.target.value === "outline" ? "outline" : "itop"); setToken(""); setEndpoint(""); setTicketMappingText("");
        }} className="ml-3 rounded border bg-background p-2">
          <option value="itop">iTop</option><option value="outline">{t("settings.integrationConnections.outline")}</option>
        </select>
      </label>
      <label>{t("settings.integrationConnections.name")}<Input value={name} maxLength={100} required disabled={busy} onChange={(event) => { setName(event.target.value); }} /></label>
      <label>{t("settings.integrationConnections.endpoint")}<Input type="url" value={endpoint} required disabled={busy || editingId !== null} onChange={(event) => { setEndpoint(event.target.value); }} /></label>
      <label>{t("settings.integrationConnections.token")}<Input type="password" autoComplete="new-password" value={token} required disabled={busy} onChange={(event) => { setToken(event.target.value); }} /></label>
      {pluginId === "itop" && <label>{t("settings.integrationConnections.ticketMapping")}
        <textarea value={ticketMappingText} disabled={busy} onChange={(event) => { setTicketMappingText(event.target.value); }} className="mt-1 min-h-40 w-full rounded border bg-background p-2 font-mono text-xs" />
      </label>}
      <Button type="submit" disabled={busy}>{t("settings.integrationConnections.save")}</Button>
      {editingId !== null && <Button type="button" variant="outline" disabled={busy} onClick={() => {
        setEditingId(null); setTicketMappingText(""); setName(""); setEndpoint(""); setToken("");
      }}>{t("settings.integrationConnections.cancel")}</Button>}
    </form>
  </section>;
}
