export type DesktopPluginStoredAuthValue =
  | string
  | number
  | boolean
  | null
  | DesktopPluginStoredAuthValue[]
  | { [key: string]: DesktopPluginStoredAuthValue };

export type DesktopPluginStoredAuthRecord = Record<
  string,
  DesktopPluginStoredAuthValue
>;

export interface DesktopPluginStoredAuthStore {
  get(pluginId: string): Promise<DesktopPluginStoredAuthRecord>;
  set(
    pluginId: string,
    values: DesktopPluginStoredAuthRecord,
  ): Promise<DesktopPluginStoredAuthRecord>;
  clear(pluginId: string): Promise<void>;
}

export const NOOP_DESKTOP_PLUGIN_STORED_AUTH_STORE: DesktopPluginStoredAuthStore = {
  get(): Promise<DesktopPluginStoredAuthRecord> {
    return Promise.resolve({});
  },
  set(
    _pluginId: string,
    values: DesktopPluginStoredAuthRecord,
  ): Promise<DesktopPluginStoredAuthRecord> {
    return Promise.resolve(values);
  },
  clear(): Promise<void> {
    return Promise.resolve();
  },
};
