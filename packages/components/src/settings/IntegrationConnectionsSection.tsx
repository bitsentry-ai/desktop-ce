import type { PluginDescriptor } from "../services/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "@bitsentry-ce/i18n";
import type { IntegrationConnection, IntegrationConnectionInput, DesktopPluginFieldDefinition } from "@bitsentry-ce/core/features/plugins";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export interface IntegrationConnectionsPort {
  list(): Promise<IntegrationConnection[]>;
  listPlugins(): Promise<PluginDescriptor[]>;
  save(input: IntegrationConnectionInput): Promise<unknown>;
  remove(id: string): Promise<unknown>;
}

function parseFields(fields: DesktopPluginFieldDefinition[], values: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(fields.flatMap((field) => {
    const value = values[field.key];
    if (value === undefined || value === "") return field.defaultValue === undefined ? [] : [[field.key, field.defaultValue]];
    if (field.type === "json" || field.type === "string_array") return [[field.key, JSON.parse(value) as unknown]];
    if (field.type === "number") return [[field.key, Number(value)]];
    if (field.type === "boolean") return [[field.key, value === "true"]];
    return [[field.key, value]];
  }));
}

export function IntegrationConnectionsSection({ service }: { service: IntegrationConnectionsPort }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<IntegrationConnection[]>([]);
  const [plugins, setPlugins] = useState<PluginDescriptor[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pluginId, setPluginId] = useState("");
  const [name, setName] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [auth, setAuth] = useState<Record<string, string>>({});
  const [connectionEnabled, setConnectionEnabled] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const listRequestVersion = useRef(0);
  const plugin = plugins.find((item) => item.id === pluginId);
  const contract = plugin?.metadata?.persistence;
  useEffect(() => {
    const requestVersion = ++listRequestVersion.current;
    void service.list().then((result) => {
      if (requestVersion === listRequestVersion.current) setRows(result);
    }, () => {
      if (requestVersion === listRequestVersion.current) setError(t("settings.integrationConnections.loadFailed"));
    });
    return () => { listRequestVersion.current += 1; };
  }, [service, t]);
  // The plugin choices do not wait for the connection list: a slow list must not leave the form empty.
  useEffect(() => {
    let active = true;
    void service.listPlugins().then((available) => {
      if (active) setPlugins(available.filter((item) => item.metadata?.persistence !== undefined));
    }, () => { if (active) setError(t("settings.integrationConnections.loadFailed")); });
    return () => { active = false; };
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

  function reset() { setEditingId(null); setName(""); setConfig({}); setAuth({}); setConnectionEnabled(true); }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !plugin || !contract) return;
    setBusy(true); setError(null);
    try {
      await service.save({
        id: editingId ?? crypto.randomUUID(), name, pluginId, enabled: connectionEnabled,
        configVersion: contract.configVersion, config: parseFields(contract.configFields, config),
        // Blank credentials on an edit keep what is stored; the host never receives an empty value as a credential.
        auth: Object.fromEntries(Object.entries(auth).filter(([, value]) => value !== "")),
      });
      reset();
      await refreshRows();
    } catch { setError(t("settings.integrationConnections.saveFailed")); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await service.remove(id);
      if (editingId === id) reset();
      await refreshRows();
    }
    catch { setError(t("settings.integrationConnections.removeFailed")); }
    finally { setBusy(false); }
  }
  function fieldInput(field: DesktopPluginFieldDefinition, secret: boolean) {
    const values = secret ? auth : config;
    const change = (value: string) => (secret ? setAuth : setConfig)((old) => ({ ...old, [field.key]: value }));
    // A stored credential stays when the field is left blank, so only a new connection must fill the required ones.
    const required = field.required === true && !(secret && editingId !== null);
    const value = values[field.key] ?? "";
    if (field.type === "json" || field.type === "string_array") return <textarea value={value} required={required} disabled={busy} onChange={(event) => change(event.target.value)} className="mt-1 min-h-32 w-full rounded border bg-background p-2 font-mono text-xs" />;
    if (field.type === "boolean" || field.enumValues) return <select value={value} required={required} disabled={busy} onChange={(event) => change(event.target.value)} className="ml-3 rounded border bg-background p-2"><option value="" />{(field.enumValues ?? ["true", "false"]).map((option) => <option key={option} value={option}>{option}</option>)}</select>;
    return <Input type={secret && field.secret === true ? "password" : field.type === "number" ? "number" : "text"} autoComplete={secret ? "new-password" : "off"} value={value} required={required} disabled={busy} onChange={(event) => change(event.target.value)} />;
  }
  return <section className="mb-6 space-y-4 rounded-md border border-border p-6">
    <h2 className="text-lg font-medium">{t("settings.integrationConnections.title")}</h2>
    <p className="text-sm text-muted-foreground">{t("settings.integrationConnections.description")}</p>
    {error !== null && <p role="alert" className="text-destructive">{error}</p>}
    <ul className="space-y-2">{rows.map((row) => <li key={row.id} className="flex items-center gap-3">
      <span className="min-w-0 flex-1 break-all">{row.name} — {row.target}</span>
      <Button disabled={busy || !plugins.some((item) => item.id === row.pluginId)} variant="outline" onClick={() => {
        setEditingId(row.id); setName(row.name); setPluginId(row.pluginId); setAuth({}); setConnectionEnabled(row.enabled);
        setConfig(Object.fromEntries(Object.entries(row.config ?? {}).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value, null, 2)])));
      }}>{t("settings.integrationConnections.edit")}</Button>
      <Button disabled={busy} variant="outline" onClick={() => { void remove(row.id); }}>{t("settings.integrationConnections.remove")}</Button>
    </li>)}</ul>
    <form onSubmit={(event) => { void save(event); }} className="grid gap-3">
      <label>{t("settings.integrationConnections.plugin")}
        <select value={pluginId} required disabled={busy || editingId !== null} onChange={(event) => { setPluginId(event.target.value); reset(); }} className="ml-3 rounded border bg-background p-2">
          <option value="" />{plugins.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <label>{t("settings.integrationConnections.name")}<Input value={name} maxLength={100} required disabled={busy} onChange={(event) => { setName(event.target.value); }} /></label>
      {contract?.configFields.map((field) => <label key={field.key}>{field.label}{fieldInput(field, false)}</label>)}
      {plugin?.auth.fields.map((field) => <label key={field.key}>{field.label}{fieldInput(field, true)}</label>)}
      <Button type="submit" disabled={busy || !contract}>{t("settings.integrationConnections.save")}</Button>
      {editingId !== null && <Button type="button" variant="outline" disabled={busy} onClick={reset}>{t("settings.integrationConnections.cancel")}</Button>}
    </form>
  </section>;
}
