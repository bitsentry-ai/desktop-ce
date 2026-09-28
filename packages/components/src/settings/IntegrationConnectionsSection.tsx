import { useEffect, useRef, useState, type FormEvent } from "react";
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
  const [authMode, setAuthMode] = useState<"token" | "username_password">("token");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [connectionEnabled, setConnectionEnabled] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const listRequestVersion = useRef(0);
  useEffect(() => {
    const requestVersion = ++listRequestVersion.current;
    void service.list().then((result) => {
      if (requestVersion === listRequestVersion.current) setRows(result);
    }, () => {
      if (requestVersion === listRequestVersion.current) setError(t("settings.integrationConnections.loadFailed"));
    });
    return () => { listRequestVersion.current += 1; };
  }, [service, t]);

  async function refreshRows() {
    const requestVersion = ++listRequestVersion.current;
    try {
      const result = await service.list();
      if (requestVersion === listRequestVersion.current) setRows(result);
    } catch {
      if (requestVersion === listRequestVersion.current) setError(t("settings.integrationConnections.loadFailed"));
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await service.save({
        id: editingId ?? crypto.randomUUID(), name, pluginId, enabled: connectionEnabled,
        auth: pluginId === "itop"
          ? authMode === "token" ? { baseUrl: endpoint, authToken: token } : { baseUrl: endpoint, username, password }
          : { apiBase: endpoint, accessToken: token },
      });
      setToken(""); setUsername(""); setPassword(""); setName(""); setEndpoint(""); setEditingId(null); setAuthMode("token"); setConnectionEnabled(true);
      await refreshRows();
    } catch { setError(t("settings.integrationConnections.saveFailed")); }
    finally { setBusy(false); }
  }

  async function remove(id: string) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await service.remove(id);
      if (editingId === id) {
        setEditingId(null); setName(""); setEndpoint(""); setToken(""); setUsername(""); setPassword(""); setAuthMode("token"); setConnectionEnabled(true);
      }
      await refreshRows();
    }
    catch { setError(t("settings.integrationConnections.removeFailed")); }
    finally { setBusy(false); }
  }

  return <section className="mb-6 space-y-4 rounded-md border border-border p-6">
    <h2 className="text-lg font-medium">{t("settings.integrationConnections.title")}</h2>
    <p className="text-sm text-muted-foreground">{t("settings.integrationConnections.description")}</p>
    {error !== null && <p role="alert" className="text-destructive">{error}</p>}
    <ul className="space-y-2">{rows.map((row) => <li key={row.id} className="flex items-center gap-3">
      <span className="min-w-0 flex-1 break-all">{row.name} — {row.target}</span>
      <Button disabled={busy} variant="outline" onClick={() => {
        setEditingId(row.id); setName(row.name); setPluginId(row.pluginId); setEndpoint(row.target);
        setAuthMode(row.pluginId === "itop" ? row.authMode : "token"); setToken(""); setUsername(""); setPassword(""); setConnectionEnabled(row.enabled);
      }}>{t("settings.integrationConnections.edit")}</Button>
      <Button disabled={busy} variant="outline" onClick={() => { void remove(row.id); }}>{t("settings.integrationConnections.remove")}</Button>
    </li>)}</ul>
    <form onSubmit={(event) => { void save(event); }} className="grid gap-3">
      <label>{t("settings.integrationConnections.plugin")}
        <select value={pluginId} disabled={busy || editingId !== null} onChange={(event) => {
          setPluginId(event.target.value === "outline" ? "outline" : "itop"); setAuthMode("token");
          setToken(""); setUsername(""); setPassword(""); setEndpoint("");
        }} className="ml-3 rounded border bg-background p-2">
          <option value="itop">iTop</option><option value="outline">{t("settings.integrationConnections.outline")}</option>
        </select>
      </label>
      <label>{t("settings.integrationConnections.name")}<Input value={name} maxLength={100} required disabled={busy} onChange={(event) => { setName(event.target.value); }} /></label>
      <label>{t("settings.integrationConnections.endpoint")}<Input type="url" value={endpoint} required disabled={busy} onChange={(event) => { setEndpoint(event.target.value); }} /></label>
      {pluginId === "itop" && <label>{t("settings.integrationConnections.authMethod")}
        <select value={authMode} disabled={busy} onChange={(event) => {
          setAuthMode(event.target.value === "username_password" ? "username_password" : "token");
          setToken(""); setUsername(""); setPassword("");
        }} className="ml-3 rounded border bg-background p-2">
          <option value="token">{t("settings.integrationConnections.token")}</option>
          <option value="username_password">{t("settings.integrationConnections.usernamePassword")}</option>
        </select>
      </label>}
      {(pluginId === "outline" || authMode === "token") && <label>{t("settings.integrationConnections.token")}
        <Input type="password" autoComplete="new-password" value={token} required disabled={busy} onChange={(event) => { setToken(event.target.value); }} />
      </label>}
      {pluginId === "itop" && authMode === "username_password" && <>
        <label>{t("settings.integrationConnections.username")}<Input autoComplete="username" value={username} required disabled={busy} onChange={(event) => { setUsername(event.target.value); }} /></label>
        <label>{t("settings.integrationConnections.password")}<Input type="password" autoComplete="new-password" value={password} required disabled={busy} onChange={(event) => { setPassword(event.target.value); }} /></label>
      </>}
      <Button type="submit" disabled={busy}>{t("settings.integrationConnections.save")}</Button>
      {editingId !== null && <Button type="button" variant="outline" disabled={busy} onClick={() => {
        setEditingId(null); setName(""); setEndpoint(""); setToken(""); setUsername(""); setPassword(""); setAuthMode("token"); setConnectionEnabled(true);
      }}>{t("settings.integrationConnections.cancel")}</Button>}
    </form>
  </section>;
}
