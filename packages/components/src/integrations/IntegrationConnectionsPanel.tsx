import type { PluginDescriptor } from "../services/contracts";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "@bitsentry-ce/i18n";
import type { IntegrationConnection, IntegrationConnectionInput, DesktopPluginFieldDefinition } from "@bitsentry-ce/core/features/plugins";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";

/** How a host lists, saves and removes named connections. Desktop backs it with local IPC, the Dashboard with its API. */
export interface IntegrationConnectionsPort {
  list(): Promise<IntegrationConnection[]>;
  /** Every plugin the host offers; only those that declare a connection contract are shown. */
  listPlugins(): Promise<PluginDescriptor[]>;
  save(input: IntegrationConnectionInput): Promise<unknown>;
  remove(id: string): Promise<unknown>;
}

/** A save the host refuses for a reason the user can fix, such as an invalid mapping; its message is shown as is. */
export class IntegrationConnectionInputError extends Error {}

export interface IntegrationConnectionsPanelProps {
  service: IntegrationConnectionsPort;
  /** The host's next step when no plugin supports named connections, such as a link to plugin management. */
  emptyAction?: ReactNode;
  /** Opens this connection in the form once it is listed, for a deep link. */
  editConnectionId?: string | null;
  /** Clears the form and focuses the name, for a "new connection" deep link. */
  startNew?: boolean;
  /** Reports the connection being edited, or null, so the host can keep its URL in step. */
  onEditConnectionChange?: (id: string | null) => void;
}

type PluginState = { status: "loading" } | { status: "failed" } | { status: "ready"; plugins: PluginDescriptor[] };

const invalidJson = Symbol("invalid JSON");

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return invalidJson;
  }
}

/** Converts the form's text values to the types the plugin declares; returns the label of the first field that is not valid JSON. */
function parseFields(fields: DesktopPluginFieldDefinition[], values: Record<string, string>): { config: Record<string, unknown> } | { invalidField: string } {
  const config: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.key];
    if (value === undefined || value === "") {
      if (field.defaultValue !== undefined) config[field.key] = field.defaultValue;
    } else if (field.type === "json" || field.type === "string_array") {
      const parsed = parseJson(value);
      if (parsed === invalidJson) return { invalidField: field.label };
      config[field.key] = parsed;
    } else if (field.type === "number") {
      config[field.key] = Number(value);
    } else if (field.type === "boolean") {
      config[field.key] = value === "true";
    } else {
      config[field.key] = value;
    }
  }
  return { config };
}

/** Alternative credential sets the plugin accepts, such as a token or a username and password. */
function credentialSets(plugin: PluginDescriptor | undefined): string[][] {
  return plugin?.auth.requiredSets ?? [];
}

function setLabel(plugin: PluginDescriptor, keys: string[]): string {
  return keys.map((key) => plugin.auth.fields.find((field) => field.key === key)?.label ?? key).join(" + ");
}

function eligiblePlugins(plugins: PluginDescriptor[]): PluginDescriptor[] {
  return plugins.filter((item) => item.metadata?.persistence !== undefined);
}

export function IntegrationConnectionsPanel({ service, emptyAction, editConnectionId = null, startNew = false, onEditConnectionChange }: IntegrationConnectionsPanelProps) {
  const { t } = useTranslation();
  const formId = useId();
  const [rows, setRows] = useState<IntegrationConnection[]>([]);
  const [pluginState, setPluginState] = useState<PluginState>({ status: "loading" });
  const [listFailed, setListFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pluginId, setPluginId] = useState("");
  const [name, setName] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [auth, setAuth] = useState<Record<string, string>>({});
  const [credentialSet, setCredentialSet] = useState(0);
  const [connectionEnabled, setConnectionEnabled] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const listRequestVersion = useRef(0);
  const nameInputRef = useRef<HTMLInputElement>(null);
  // The deep-linked connection already loaded into the form; a later list refresh must not overwrite edits.
  const [appliedEditId, setAppliedEditId] = useState<string | null>(null);
  const [seenStartNew, setSeenStartNew] = useState(false);

  const plugins = pluginState.status === "ready" ? pluginState.plugins : [];
  // Without an explicit choice the first eligible plugin is selected, so the form is never blank.
  const selectedPluginId = pluginId !== "" ? pluginId : (plugins[0]?.id ?? "");
  const plugin = plugins.find((item) => item.id === selectedPluginId);
  const contract = plugin?.metadata?.persistence;
  const sets = credentialSets(plugin);
  const chosenSet = new Set(sets[credentialSet] ?? sets[0] ?? []);
  // Asked for: the chosen credential set, plus required fields. An optional field with a declared default is not
  // asked for (the plugin uses its default); such fields are legacy settings, like a base URL the connection's
  // destination already gives.
  const authFields = (plugin?.auth.fields ?? []).filter((field) => {
    if (chosenSet.has(field.key) || field.required === true) return true;
    return sets.length === 0 && field.defaultValue === undefined;
  });

  useEffect(() => {
    const requestVersion = ++listRequestVersion.current;
    void service.list().then((result) => {
      if (requestVersion === listRequestVersion.current) { setRows(result); setListFailed(false); }
    }, () => {
      if (requestVersion === listRequestVersion.current) setListFailed(true);
    });
    return () => { listRequestVersion.current += 1; };
  }, [service, reloadKey]);
  // The plugin choices do not wait for the connection list: a slow list must not leave the form empty.
  useEffect(() => {
    let active = true;
    void service.listPlugins().then((available) => {
      if (active) setPluginState({ status: "ready", plugins: eligiblePlugins(available) });
    }, () => { if (active) setPluginState({ status: "failed" }); });
    return () => { active = false; };
  }, [service, reloadKey]);

  function refreshRows(): Promise<void> {
    const requestVersion = ++listRequestVersion.current;
    return service.list().then((result) => {
      if (requestVersion === listRequestVersion.current) { setRows(result); setListFailed(false); }
    }, () => {
      if (requestVersion === listRequestVersion.current) setListFailed(true);
    });
  }

  function reset() { setEditingId(null); setName(""); setConfig({}); setAuth({}); setCredentialSet(0); setConnectionEnabled(true); }

  function startEdit(row: IntegrationConnection) {
    setEditingId(row.id); setName(row.name); setPluginId(row.pluginId); setAuth({}); setCredentialSet(0); setConnectionEnabled(row.enabled);
    setConfig(Object.fromEntries(Object.entries(row.config ?? {}).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value, null, 2)])));
  }

  // Deep links are applied while rendering, once per requested value, so a list refresh never overwrites edits.
  if (editConnectionId === null && appliedEditId !== null) {
    setAppliedEditId(null);
  } else if (editConnectionId !== null && editConnectionId !== appliedEditId) {
    const row = rows.find((item) => item.id === editConnectionId);
    if (row !== undefined) {
      setAppliedEditId(editConnectionId);
      startEdit(row);
    }
  }
  if (startNew !== seenStartNew) {
    setSeenStartNew(startNew);
    if (startNew) reset();
  }
  useEffect(() => {
    if (startNew) nameInputRef.current?.focus();
  }, [startNew]);

  function finishEdit() {
    reset();
    onEditConnectionChange?.(null);
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (busy || plugin === undefined || contract === undefined) return;
    const parsed = parseFields(contract.configFields, config);
    if ("invalidField" in parsed) {
      setError(t("settings.integrationConnections.invalidJson", { field: parsed.invalidField }));
      return;
    }
    setBusy(true); setError(null);
    const input: IntegrationConnectionInput = {
      id: editingId ?? crypto.randomUUID(), name, pluginId: plugin.id, enabled: connectionEnabled,
      configVersion: contract.configVersion, config: parsed.config,
      // Blank credentials on an edit keep what is stored; the host never receives an empty value as a credential.
      auth: Object.fromEntries(Object.entries(auth).filter(([key, value]) => value !== "" && authFields.some((field) => field.key === key))),
    };
    void service.save(input).then(() => {
      finishEdit();
      return refreshRows();
    }, (reason: unknown) => {
      setError(reason instanceof IntegrationConnectionInputError ? reason.message : t("settings.integrationConnections.saveFailed"));
    }).finally(() => { setBusy(false); });
  }

  function remove(id: string) {
    if (busy) return;
    setBusy(true); setError(null);
    void service.remove(id).then(() => {
      if (editingId === id) finishEdit();
      return refreshRows();
    }, () => { setError(t("settings.integrationConnections.removeFailed")); }).finally(() => { setBusy(false); });
  }

  function retry() {
    setError(null);
    setListFailed(false);
    setPluginState({ status: "loading" });
    setReloadKey((value) => value + 1);
  }

  function fieldInput(field: DesktopPluginFieldDefinition, secret: boolean, id: string) {
    const values = secret ? auth : config;
    const value = values[field.key] ?? "";
    const change = (next: string) => { (secret ? setAuth : setConfig)((old) => ({ ...old, [field.key]: next })); };
    // A stored credential stays when the field is left blank, so only a new connection must fill the required ones.
    const required = (field.required === true || (secret && chosenSet.has(field.key))) && !(secret && editingId !== null);
    const targetLocked = !secret && editingId !== null && field.key === contract?.destinationField;
    const disabled = busy || targetLocked;
    if (field.type === "json" || field.type === "string_array") {
      return <Textarea id={id} value={value} required={required} disabled={disabled} spellCheck={false} onChange={(event) => { change(event.target.value); }} className="min-h-32 font-mono text-xs" />;
    }
    if (field.type === "boolean" || field.enumValues !== undefined) {
      return <Select value={value === "" ? undefined : value} required={required} disabled={disabled} onValueChange={change}>
        <SelectTrigger id={id}><SelectValue /></SelectTrigger>
        <SelectContent>{(field.enumValues ?? ["true", "false"]).map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent>
      </Select>;
    }
    let type = "text";
    if (secret && field.secret === true) type = "password";
    else if (field.type === "number") type = "number";
    return <Input id={id} type={type} autoComplete={secret ? "new-password" : "off"} value={value} required={required} disabled={disabled} onChange={(event) => { change(event.target.value); }} />;
  }

  function status(row: IntegrationConnection) {
    if (!row.enabled) return <Badge variant="secondary">{t("settings.integrationConnections.inactive")}</Badge>;
    if (row.availability === "configured") return <Badge variant="success">{t("settings.integrationConnections.active")}</Badge>;
    return <Badge variant="warning">{t(`settings.integrationConnections.availability.${row.availability}`)}</Badge>;
  }

  const loadFailed = listFailed || pluginState.status === "failed";

  return <section className="space-y-4" aria-labelledby={`${formId}-title`}>
    <div>
      <h2 id={`${formId}-title`} className="text-sm font-semibold text-foreground">{t("settings.integrationConnections.title")}</h2>
      <p className="text-xs text-muted-foreground">{t("settings.integrationConnections.description")}</p>
    </div>

    {loadFailed && <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
      <span>{t("settings.integrationConnections.loadFailed")}</span>
      <Button type="button" size="sm" variant="outline" onClick={retry}>{t("settings.integrationConnections.retry")}</Button>
    </div>}
    {error !== null && <p role="alert" className="text-sm text-destructive">{error}</p>}

    {rows.length > 0 && <ul className="divide-y divide-border rounded-md border border-border">{rows.map((row) => <li key={row.id} className="flex items-center gap-2 px-3 py-2">
      <span className="min-w-0 flex-1 break-all text-sm">{row.name} <span className="text-muted-foreground">— {row.target}</span></span>
      {status(row)}
      <Button size="sm" variant="outline" disabled={busy || !plugins.some((item) => item.id === row.pluginId)} onClick={() => {
        setAppliedEditId(row.id);
        startEdit(row);
        onEditConnectionChange?.(row.id);
      }}>{t("settings.integrationConnections.edit")}</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => { remove(row.id); }}>{t("settings.integrationConnections.remove")}</Button>
    </li>)}</ul>}

    {pluginState.status === "loading" && <p role="status" className="text-sm text-muted-foreground">{t("settings.integrationConnections.loading")}</p>}

    {pluginState.status === "ready" && plugins.length === 0 && <div className="space-y-2 rounded-md border border-dashed border-border p-6 text-center">
      <p className="text-sm font-medium text-foreground">{t("settings.integrationConnections.noPlugins")}</p>
      <p className="text-xs text-muted-foreground">{t("settings.integrationConnections.noPluginsHint")}</p>
      {emptyAction}
    </div>}

    {plugin !== undefined && contract !== undefined && <form onSubmit={save} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor={`${formId}-plugin`}>{t("settings.integrationConnections.plugin")}</Label>
          <Select value={selectedPluginId} disabled={busy || editingId !== null} onValueChange={(value) => { setPluginId(value); reset(); }}>
            <SelectTrigger id={`${formId}-plugin`}><SelectValue /></SelectTrigger>
            <SelectContent>{plugins.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        {sets.length > 1 && <div className="space-y-2">
          <Label htmlFor={`${formId}-credentials`}>{t("settings.integrationConnections.authMethod")}</Label>
          <Select value={String(credentialSet)} disabled={busy} onValueChange={(value) => { setCredentialSet(Number(value)); setAuth({}); }}>
            <SelectTrigger id={`${formId}-credentials`}><SelectValue /></SelectTrigger>
            <SelectContent>{sets.map((keys, index) => <SelectItem key={keys.join("+")} value={String(index)}>{setLabel(plugin, keys)}</SelectItem>)}</SelectContent>
          </Select>
        </div>}
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${formId}-name`}>{t("settings.integrationConnections.name")}</Label>
        <Input id={`${formId}-name`} ref={nameInputRef} value={name} maxLength={100} required disabled={busy} onChange={(event) => { setName(event.target.value); }} />
      </div>
      {contract.configFields.map((field) => <div key={field.key} className="space-y-2">
        <Label htmlFor={`${formId}-config-${field.key}`}>{field.label}</Label>
        {fieldInput(field, false, `${formId}-config-${field.key}`)}
      </div>)}
      {authFields.map((field) => <div key={field.key} className="space-y-2">
        <Label htmlFor={`${formId}-auth-${field.key}`}>{field.label}</Label>
        {fieldInput(field, true, `${formId}-auth-${field.key}`)}
      </div>)}

      <label className="flex items-center justify-between gap-4 rounded-md border border-border px-4 py-3">
        <span className="min-w-0">
          <span className="block text-sm text-foreground">{t("settings.integrationConnections.active")}</span>
          <span className="block text-xs text-muted-foreground">{t("settings.integrationConnections.activeHint")}</span>
        </span>
        <input type="checkbox" className="h-4 w-4 accent-primary" checked={connectionEnabled} disabled={busy} onChange={(event) => { setConnectionEnabled(event.target.checked); }} />
      </label>

      <p className="text-xs text-muted-foreground">{t("settings.integrationConnections.targetImmutable")}</p>
      <div className="flex justify-end gap-2">
        {editingId !== null && <Button type="button" variant="outline" disabled={busy} onClick={finishEdit}>{t("settings.integrationConnections.cancel")}</Button>}
        <Button type="submit" disabled={busy}>{t("settings.integrationConnections.save")}</Button>
      </div>
    </form>}
  </section>;
}
