import type { PluginDescriptor } from "../services/contracts";
import { ChevronRight, MoreHorizontal, Plug, Plus, Trash2 } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "@bitsentry-ce/i18n";
import type { IntegrationConnection, IntegrationConnectionInput, DesktopPluginFieldDefinition } from "@bitsentry-ce/core/features/plugins";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { EmptyState } from "../ui/empty-state";
import { settingsDescriptionClass, settingsLabelClass, settingsSectionTitleClass } from "../settings/SettingsRow";
import { cn } from "../lib/utils";

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

/** Optional JSON settings, such as ticket mappings: shown under a collapsed "Advanced" disclosure. */
function isAdvancedField(field: DesktopPluginFieldDefinition): boolean {
  return field.required !== true && field.type === "json";
}

function hasAdvancedValue(plugin: PluginDescriptor | undefined, config: Record<string, unknown> | undefined): boolean {
  const fields = plugin?.metadata?.persistence?.configFields ?? [];
  return fields.some((field) => isAdvancedField(field) && config?.[field.key] !== undefined);
}

const cardClass = "rounded-lg border border-border bg-card";

function ConnectionStatus({ row }: { row: IntegrationConnection }) {
  const { t } = useTranslation();
  if (!row.enabled) return <Badge variant="secondary">{t("settings.integrationConnections.inactive")}</Badge>;
  if (row.availability === "configured") return <Badge variant="success">{t("settings.integrationConnections.active")}</Badge>;
  return <Badge variant="warning">{t(`settings.integrationConnections.availability.${row.availability}`)}</Badge>;
}

interface ConnectionListProps {
  titleId: string;
  rows: IntegrationConnection[];
  plugins: PluginDescriptor[];
  /** The list has loaded, so an empty list means there are no connections rather than none yet fetched. */
  loaded: boolean;
  busy: boolean;
  onEdit: (row: IntegrationConnection) => void;
  onRemove: (id: string) => void;
  /** Opens the form for a new connection. */
  onAdd: () => void;
  /** Hides Add connection while the form is already open. */
  formOpen: boolean;
}

function ConnectionService({ name }: { name: string | undefined }) {
  if (name === undefined) return null;
  return <span className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 text-xs font-normal leading-5 text-muted-foreground">
    <Plug aria-hidden="true" className="size-3" />
    {name}
  </span>;
}

/** Less frequent row actions behind ⋯, so Remove never sits beside Edit as an equal. */
function ConnectionMenu({ name, disabled, onRemove }: { name: string; disabled: boolean; onRemove: () => void }) {
  const { t } = useTranslation();
  const label = t("settings.integrationConnections.moreActions", { name });
  return <DropdownMenu modal={false}>
    <DropdownMenuTrigger asChild>
      <Button size="sm" variant="ghost" aria-label={label} title={label} disabled={disabled} className="size-8 p-0 max-sm:size-11">
        <MoreHorizontal aria-hidden="true" className="size-4" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="min-w-40">
      <DropdownMenuItem onSelect={onRemove} className="text-destructive focus:bg-destructive/10 focus:text-destructive max-sm:min-h-11">
        <Trash2 aria-hidden="true" className="size-3.5" />
        {t("settings.integrationConnections.remove")}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}

/** The saved connections, in a card of their own above the form that adds one. */
function ConnectionList({ titleId, rows, plugins, loaded, busy, onEdit, onRemove, onAdd, formOpen }: ConnectionListProps) {
  const { t } = useTranslation();
  return <section aria-labelledby={titleId} className={cardClass}>
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
      <div className="min-w-0">
        <h2 id={titleId} className={settingsSectionTitleClass}>{t("settings.integrationConnections.connectionsHeading")}</h2>
        <p className={settingsDescriptionClass}>{t("settings.integrationConnections.connectionsDescription")}</p>
      </div>
      {!formOpen && <Button type="button" size="sm" className="shrink-0 gap-1.5 max-sm:h-11 max-sm:px-4" disabled={busy} onClick={onAdd}>
        <Plus aria-hidden="true" className="size-3.5" />
        {t("settings.integrationConnections.addHeading")}
      </Button>}
    </div>
    {rows.length === 0 && loaded && <p className={cn("px-4 py-3", settingsDescriptionClass)}>{t("settings.integrationConnections.noConnections")}</p>}
    {rows.length > 0 && <ul className="divide-y divide-border">{rows.map((row) => <li key={row.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-2 text-sm font-medium leading-5 text-foreground">
          <span className="truncate" title={row.name}>{row.name}</span>
          {/* The service it connects to, so Outline and iTop rows are told apart without the sidebar. */}
          <ConnectionService name={plugins.find((item) => item.id === row.pluginId)?.name} />
        </p>
        <p className="truncate font-mono text-[12.5px] leading-5 text-muted-foreground" title={row.target}>{row.target}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <ConnectionStatus row={row} />
        <Button size="sm" variant="outline" className="max-sm:h-11 max-sm:px-4" disabled={busy || !plugins.some((item) => item.id === row.pluginId)} onClick={() => { onEdit(row); }}>{t("settings.integrationConnections.edit")}</Button>
        <ConnectionMenu name={row.name} disabled={busy} onRemove={() => { onRemove(row.id); }} />
      </div>
    </li>)}</ul>}
  </section>;
}

/** Optional settings most connections never need, collapsed until opened or filled. */
function AdvancedFields({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  const { t } = useTranslation();
  return <details open={open} onToggle={(event) => { onOpenChange(event.currentTarget.open); }} className="group rounded-md border border-border">
    <summary className="flex cursor-pointer select-none list-none items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
      <ChevronRight aria-hidden={true} className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
      {t("settings.integrationConnections.advanced")}
    </summary>
    <div className="space-y-4 border-t border-border p-3">{children}</div>
  </details>;
}

/**
 * Whether the add/edit form shows. Once connections exist, adding one is on demand (Add connection), so the saved
 * connections lead the page; with none yet, the form is the page's main content.
 */
function useConnectionForm(rowCount: number, editing: boolean, startNew: boolean) {
  const [addOpen, setAddOpen] = useState(false);
  const formVisible = editing || addOpen || startNew || rowCount === 0;
  const showCancel = editing || (addOpen && rowCount > 0);
  return { addOpen, setAddOpen, formVisible, showCancel };
}

export function IntegrationConnectionsPanel({ service, emptyAction, editConnectionId = null, startNew = false, onEditConnectionChange }: IntegrationConnectionsPanelProps) {
  const { t } = useTranslation();
  const formId = useId();
  const [rows, setRows] = useState<IntegrationConnection[]>([]);
  const [pluginState, setPluginState] = useState<PluginState>({ status: "loading" });
  const [listFailed, setListFailed] = useState(false);
  const [listLoaded, setListLoaded] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
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
  const { addOpen, setAddOpen, formVisible, showCancel } = useConnectionForm(rows.length, editingId !== null, startNew);
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
      if (requestVersion === listRequestVersion.current) { setRows(result); setListFailed(false); setListLoaded(true); }
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
      if (requestVersion === listRequestVersion.current) { setRows(result); setListFailed(false); setListLoaded(true); }
    }, () => {
      if (requestVersion === listRequestVersion.current) setListFailed(true);
    });
  }

  function reset() { setEditingId(null); setName(""); setConfig({}); setAuth({}); setCredentialSet(0); setConnectionEnabled(true); setAdvancedOpen(false); }

  function startEdit(row: IntegrationConnection) {
    setEditingId(row.id); setName(row.name); setPluginId(row.pluginId); setAuth({}); setCredentialSet(0); setConnectionEnabled(row.enabled);
    setAdvancedOpen(hasAdvancedValue(plugins.find((item) => item.id === row.pluginId), row.config));
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
    setAddOpen(false);
    onEditConnectionChange?.(null);
  }

  function openAdd() {
    reset();
    setAddOpen(true);
    onEditConnectionChange?.(null);
  }
  useEffect(() => {
    if (addOpen) nameInputRef.current?.focus();
  }, [addOpen]);

  function save(event: FormEvent) {
    event.preventDefault();
    if (busy || plugin === undefined || contract === undefined) return;
    const parsed = parseFields(contract.configFields, config);
    if ("invalidField" in parsed) {
      // A field that does not parse may sit under "Advanced"; open it so the user can see what to fix.
      if (contract.configFields.some((field) => field.label === parsed.invalidField && isAdvancedField(field))) setAdvancedOpen(true);
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

  function configField(field: DesktopPluginFieldDefinition) {
    return <div key={field.key} className="space-y-2">
      <Label htmlFor={`${formId}-config-${field.key}`}>{field.label}</Label>
      {fieldInput(field, false, `${formId}-config-${field.key}`)}
    </div>;
  }

  function editRow(row: IntegrationConnection) {
    setAppliedEditId(row.id);
    startEdit(row);
    onEditConnectionChange?.(row.id);
  }

  const loadFailed = listFailed || pluginState.status === "failed";
  const noPlugins = pluginState.status === "ready" && plugins.length === 0;
  const configFields = contract?.configFields ?? [];
  const advancedFields = configFields.filter(isAdvancedField);
  const errorAlert = error === null ? null : <p role="alert" className="text-sm text-destructive">{error}</p>;
  const formHeading = editingId === null ? t("settings.integrationConnections.addHeading") : t("settings.integrationConnections.editHeading");

  // Existing connections and the form that adds one are separate cards; with no plugin to connect, one compact
  // empty state takes their place.
  return <div className="space-y-6">
    {loadFailed && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
      <span>{t("settings.integrationConnections.loadFailed")}</span>
      <Button type="button" size="sm" variant="outline" onClick={retry}>{t("settings.integrationConnections.retry")}</Button>
    </div>}
    {contract === undefined && errorAlert}

    {(rows.length > 0 || (listLoaded && plugins.length > 0)) && <ConnectionList
      titleId={`${formId}-connections`}
      rows={rows}
      plugins={plugins}
      loaded={listLoaded}
      busy={busy}
      onEdit={editRow}
      onRemove={remove}
      onAdd={openAdd}
      formOpen={formVisible}
    />}

    {pluginState.status === "loading" && <p role="status" className="text-sm text-muted-foreground">{t("settings.integrationConnections.loading")}</p>}

    {noPlugins && <div className={cardClass}>
      <EmptyState
        icon={Plug}
        title={t("settings.integrationConnections.emptyTitle")}
        description={t("settings.integrationConnections.emptyDescription")}
        action={emptyAction}
        className="py-10"
      />
    </div>}

    {formVisible && plugin !== undefined && contract !== undefined && <section aria-labelledby={`${formId}-form-title`} className={cn(cardClass, "p-4 sm:p-6")}>
      <div className="mb-4">
        <h2 id={`${formId}-form-title`} className={settingsSectionTitleClass}>{formHeading}</h2>
        <p className={settingsDescriptionClass}>{t("settings.integrationConnections.credentialHint")}</p>
      </div>
      <form onSubmit={save} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
        {configFields.filter((field) => !isAdvancedField(field)).map(configField)}
        {authFields.map((field) => <div key={field.key} className="space-y-2">
          <Label htmlFor={`${formId}-auth-${field.key}`}>{field.label}</Label>
          {fieldInput(field, true, `${formId}-auth-${field.key}`)}
        </div>)}

        {advancedFields.length > 0 && <AdvancedFields open={advancedOpen} onOpenChange={setAdvancedOpen}>{advancedFields.map(configField)}</AdvancedFields>}

        <label className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2.5">
          <span className="min-w-0">
            <span className={settingsLabelClass}>{t("settings.integrationConnections.active")}</span>
            <span className={`block ${settingsDescriptionClass}`}>{t("settings.integrationConnections.activeHint")}</span>
          </span>
          <input type="checkbox" className="h-4 w-4 accent-primary" checked={connectionEnabled} disabled={busy} onChange={(event) => { setConnectionEnabled(event.target.checked); }} />
        </label>

        {editingId !== null && <p className={settingsDescriptionClass}>{t("settings.integrationConnections.targetImmutable")}</p>}
        {errorAlert}
        <div className="flex justify-end gap-2">
          {showCancel && <Button type="button" variant="outline" disabled={busy} onClick={finishEdit}>{t("settings.integrationConnections.cancel")}</Button>}
          <Button type="submit" disabled={busy}>{t("settings.integrationConnections.save")}</Button>
        </div>
      </form>
    </section>}
  </div>;
}
