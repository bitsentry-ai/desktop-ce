import type { SettingsUseCases } from "../ports/inbound";
import type { SettingsRepositoryPort } from "../ports/outbound";
import type {
  AlertRule,
  AllSettings,
  GeneralSettings,
  NotificationSettings,
  SecurityPolicy,
  UpdateAlertRuleInput,
  UpdateGeneralSettingsInput,
  UpdateNotificationSettingsInput,
  UpdateSecurityPolicyInput,
} from "../../contracts";
import {
  booleanValue,
  isRecord,
  numberValue,
  stringArrayValue,
  stringValue,
} from "../../../../shared/values";

interface SettingUpdate {
  key: string;
  value: unknown;
  type: string;
  userId: number;
}

type GeneralSettingAssigner = (
  settings: GeneralSettings,
  value: unknown,
) => void;

type SecurityPolicyAssigner = (
  policy: SecurityPolicy,
  value: unknown,
) => void;

type NotificationSettingAssigner = (
  settings: NotificationSettings,
  value: unknown,
) => void;

function normalizeUserId(userId: number | string): number {
  if (typeof userId === "string") return Number.parseInt(userId, 10);
  return userId;
}

function toSettingType(value: unknown): string {
  if (typeof value === "boolean") {
    return "boolean";
  }

  if (typeof value === "number") {
    return "number";
  }

  if (Array.isArray(value) || typeof value === "object") {
    return "json";
  }

  return "string";
}

function normalizeLastUsedExternalSourceId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}

function settingUpdates(
  prefix: string,
  input: object,
  userId: number,
): SettingUpdate[] {
  const updates: SettingUpdate[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    updates.push({
      key: `${prefix}.${key}`,
      value,
      type: toSettingType(value),
      userId,
    });
  }
  return updates;
}

function assignStringValue(value: unknown, assign: (value: string) => void): void {
  const normalized = stringValue(value);
  if (normalized !== undefined) assign(normalized);
}

function assignNumberValue(value: unknown, assign: (value: number) => void): void {
  const normalized = numberValue(value);
  if (normalized !== undefined) assign(normalized);
}

function assignBooleanValue(value: unknown, assign: (value: boolean) => void): void {
  const normalized = booleanValue(value);
  if (normalized !== undefined) assign(normalized);
}

function assignStringArrayValue(
  value: unknown,
  assign: (value: string[]) => void,
): void {
  const normalized = stringArrayValue(value);
  if (normalized !== undefined) assign(normalized);
}

const GENERAL_SETTING_ASSIGNERS: Readonly<
  Partial<Record<string, GeneralSettingAssigner>>
> = {
  defaultDashboard: (settings, value) =>
    { assignStringValue(value, (normalized) => {
      settings.defaultDashboard = normalized;
    }); },
  dateFormat: (settings, value) =>
    { assignStringValue(value, (normalized) => {
      settings.dateFormat = normalized;
    }); },
  language: (settings, value) =>
    { assignStringValue(value, (normalized) => {
      settings.language = normalized;
    }); },
  maintenanceMessage: (settings, value) =>
    { assignStringValue(value, (normalized) => {
      settings.maintenanceMessage = normalized;
    }); },
  maintenanceMode: (settings, value) =>
    { assignBooleanValue(value, (normalized) => {
      settings.maintenanceMode = normalized;
    }); },
  organizationName: (settings, value) =>
    { assignStringValue(value, (normalized) => {
      settings.organizationName = normalized;
    }); },
  timeFormat: (settings, value) =>
    { assignStringValue(value, (normalized) => {
      settings.timeFormat = normalized;
    }); },
  timezone: (settings, value) =>
    { assignStringValue(value, (normalized) => {
      settings.timezone = normalized;
    }); },
};

const SECURITY_POLICY_ASSIGNERS: Readonly<
  Partial<Record<string, SecurityPolicyAssigner>>
> = {
  ipWhitelist: (policy, value) =>
    { assignStringArrayValue(value, (normalized) => {
      policy.ipWhitelist = normalized;
    }); },
  ipWhitelistEnabled: (policy, value) =>
    { assignBooleanValue(value, (normalized) => {
      policy.ipWhitelistEnabled = normalized;
    }); },
  lockoutDurationMinutes: (policy, value) =>
    { assignNumberValue(value, (normalized) => {
      policy.lockoutDurationMinutes = normalized;
    }); },
  maxLoginAttempts: (policy, value) =>
    { assignNumberValue(value, (normalized) => {
      policy.maxLoginAttempts = normalized;
    }); },
  passwordExpirationDays: (policy, value) =>
    { assignNumberValue(value, (normalized) => {
      policy.passwordExpirationDays = normalized;
    }); },
  passwordMinLength: (policy, value) =>
    { assignNumberValue(value, (normalized) => {
      policy.passwordMinLength = normalized;
    }); },
  passwordRequireLowercase: (policy, value) =>
    { assignBooleanValue(value, (normalized) => {
      policy.passwordRequireLowercase = normalized;
    }); },
  passwordRequireNumbers: (policy, value) =>
    { assignBooleanValue(value, (normalized) => {
      policy.passwordRequireNumbers = normalized;
    }); },
  passwordRequireSpecialChars: (policy, value) =>
    { assignBooleanValue(value, (normalized) => {
      policy.passwordRequireSpecialChars = normalized;
    }); },
  passwordRequireUppercase: (policy, value) =>
    { assignBooleanValue(value, (normalized) => {
      policy.passwordRequireUppercase = normalized;
    }); },
  rememberMeExpiryHours: (policy, value) =>
    { assignNumberValue(value, (normalized) => {
      policy.rememberMeExpiryHours = normalized;
    }); },
  sessionTimeoutMinutes: (policy, value) =>
    { assignNumberValue(value, (normalized) => {
      policy.sessionTimeoutMinutes = normalized;
    }); },
  twoFactorEnabledDate: (policy, value) => {
    policy.twoFactorEnabledDate = stringValue(value);
  },
  twoFactorEnforcementMode: (policy, value) => {
    if (value === "warn" || value === "block") {
      policy.twoFactorEnforcementMode = value;
    }
  },
  twoFactorGracePeriodDays: (policy, value) =>
    { assignNumberValue(value, (normalized) => {
      policy.twoFactorGracePeriodDays = normalized;
    }); },
  twoFactorRequired: (policy, value) =>
    { assignBooleanValue(value, (normalized) => {
      policy.twoFactorRequired = normalized;
    }); },
};

const NOTIFICATION_SETTING_ASSIGNERS: Readonly<
  Partial<Record<string, NotificationSettingAssigner>>
> = {
  emailEnabled: (settings, value) =>
    { assignBooleanValue(value, (normalized) => {
      settings.emailEnabled = normalized;
    }); },
  emailFrom: (settings, value) =>
    { assignStringValue(value, (normalized) => {
      settings.emailFrom = normalized;
    }); },
  emailPort: (settings, value) =>
    { assignNumberValue(value, (normalized) => {
      settings.emailPort = normalized;
    }); },
  emailSecure: (settings, value) =>
    { assignBooleanValue(value, (normalized) => {
      settings.emailSecure = normalized;
    }); },
  emailServer: (settings, value) =>
    { assignStringValue(value, (normalized) => {
      settings.emailServer = normalized;
    }); },
  slackEnabled: (settings, value) =>
    { assignBooleanValue(value, (normalized) => {
      settings.slackEnabled = normalized;
    }); },
  slackWebhookUrl: (settings, value) =>
    { assignStringValue(value, (normalized) => {
      settings.slackWebhookUrl = normalized;
    }); },
  teamsEnabled: (settings, value) =>
    { assignBooleanValue(value, (normalized) => {
      settings.teamsEnabled = normalized;
    }); },
  teamsWebhookUrl: (settings, value) =>
    { assignStringValue(value, (normalized) => {
      settings.teamsWebhookUrl = normalized;
    }); },
  webhookEnabled: (settings, value) =>
    { assignBooleanValue(value, (normalized) => {
      settings.webhookEnabled = normalized;
    }); },
  webhookHeaders: (settings, value) => {
    settings.webhookHeaders = value;
  },
  webhookUrl: (settings, value) =>
    { assignStringValue(value, (normalized) => {
      settings.webhookUrl = normalized;
    }); },
};

function assignGeneralSetting(
  settings: GeneralSettings,
  key: string,
  value: unknown,
): void {
  const assign = GENERAL_SETTING_ASSIGNERS[key];
  if (assign !== undefined) assign(settings, value);
}

function assignSecurityPolicySetting(
  policy: SecurityPolicy,
  key: string,
  value: unknown,
): void {
  const assign = SECURITY_POLICY_ASSIGNERS[key];
  if (assign !== undefined) assign(policy, value);
}

function assignNotificationSetting(
  settings: NotificationSettings,
  key: string,
  value: unknown,
): void {
  const assign = NOTIFICATION_SETTING_ASSIGNERS[key];
  if (assign !== undefined) assign(settings, value);
}

interface AlertRuleFields {
  id: string;
  name: string;
  enabled: boolean;
  type: AlertRule["type"];
  severity: string[];
  channels: string[];
  recipients: string[];
}

function alertRuleFields(value: Record<string, unknown>): AlertRuleFields | undefined {
  const id = stringValue(value.id);
  const name = stringValue(value.name);
  const type = alertRuleType(value.type);
  const severity = stringArrayValue(value.severity);
  const channels = stringArrayValue(value.channels);
  const recipients = stringArrayValue(value.recipients);
  const enabled = booleanValue(value.enabled);

  if (
    id === undefined ||
    name === undefined ||
    type === undefined ||
    severity === undefined ||
    channels === undefined ||
    recipients === undefined ||
    enabled === undefined
  ) {
    return undefined;
  }

  return {
    id,
    name,
    type,
    severity,
    channels,
    recipients,
    enabled,
  };
}

function alertRuleValue(value: unknown): AlertRule | undefined {
  if (!isRecord(value)) return undefined;
  const fields = alertRuleFields(value);
  if (fields === undefined) return undefined;

  return {
    ...fields,
    conditions: value.conditions,
  };
}

function alertRuleType(value: unknown): AlertRule["type"] | undefined {
  if (
    value === "vulnerability" ||
    value === "threat" ||
    value === "agent" ||
    value === "scan" ||
    value === "incident"
  ) {
    return value;
  }

  return undefined;
}

export class SettingsUseCasesImpl implements SettingsUseCases {
  constructor(private readonly settingRepository: SettingsRepositoryPort) {}

  async initializeDefaults(userId?: number): Promise<void> {
    if (userId === undefined || userId === 0) {
      return;
    }

    const defaultSettings: Array<{
      key: string;
      value: unknown;
      type: string;
    }> = [
      { key: "general.organizationName", value: "BitSentry", type: "string" },
      { key: "general.timezone", value: "UTC", type: "string" },
      { key: "general.dateFormat", value: "YYYY-MM-DD", type: "string" },
      { key: "general.timeFormat", value: "24h", type: "string" },
      { key: "general.language", value: "en", type: "string" },
      { key: "general.defaultDashboard", value: "overview", type: "string" },
      { key: "general.maintenanceMode", value: false, type: "boolean" },
      { key: "security.passwordMinLength", value: 8, type: "number" },
      {
        key: "security.passwordRequireUppercase",
        value: true,
        type: "boolean",
      },
      {
        key: "security.passwordRequireLowercase",
        value: true,
        type: "boolean",
      },
      { key: "security.passwordRequireNumbers", value: true, type: "boolean" },
      {
        key: "security.passwordRequireSpecialChars",
        value: true,
        type: "boolean",
      },
      { key: "security.passwordExpirationDays", value: 90, type: "number" },
      { key: "security.sessionTimeoutMinutes", value: 30, type: "number" },
      { key: "security.rememberMeExpiryHours", value: 336, type: "number" },
      { key: "security.maxLoginAttempts", value: 5, type: "number" },
      { key: "security.lockoutDurationMinutes", value: 30, type: "number" },
      { key: "security.twoFactorRequired", value: false, type: "boolean" },
      { key: "security.twoFactorGracePeriodDays", value: 30, type: "number" },
      {
        key: "security.twoFactorEnforcementMode",
        value: "warn",
        type: "string",
      },
      { key: "security.ipWhitelistEnabled", value: false, type: "boolean" },
      { key: "security.ipWhitelist", value: [], type: "json" },
      { key: "notifications.emailEnabled", value: true, type: "boolean" },
      { key: "notifications.emailServer", value: "localhost", type: "string" },
      { key: "notifications.emailPort", value: 587, type: "number" },
      { key: "notifications.emailSecure", value: false, type: "boolean" },
      {
        key: "notifications.emailFrom",
        value: "noreply@bitsentry.local",
        type: "string",
      },
      { key: "notifications.slackEnabled", value: false, type: "boolean" },
      { key: "notifications.teamsEnabled", value: false, type: "boolean" },
      { key: "notifications.webhookEnabled", value: false, type: "boolean" },
    ];

    const existingKeys = (
      await this.settingRepository.findManyByKeys(
        defaultSettings.map((setting) => setting.key),
      )
    ).map((setting) => setting.key);

    const missingSettings = defaultSettings.filter(
      (setting) => !existingKeys.includes(setting.key),
    );

    if (missingSettings.length === 0) {
      return;
    }

    await this.settingRepository.upsertMany(
      missingSettings.map((setting) => ({ ...setting, userId })),
    );
  }

  async getAllSettings(): Promise<AllSettings> {
    const [general, security, notifications, alertRules] = await Promise.all([
      this.getGeneralSettings(),
      this.getSecurityPolicy(),
      this.getNotificationSettings(),
      this.getAlertRules(),
    ]);

    return {
      general,
      security,
      notifications,
      alertRules,
    };
  }

  async getGeneralSettings(): Promise<GeneralSettings> {
    const settings = await this.settingRepository.findByKeyPrefix("general.");

    const generalSettings: GeneralSettings = {
      organizationName: "",
      timezone: "UTC",
      dateFormat: "YYYY-MM-DD",
      timeFormat: "24h",
      language: "en",
      defaultDashboard: "overview",
      maintenanceMode: false,
    };

    for (const setting of settings) {
      const key = setting.key.replace("general.", "");
      if (
        key === "lastUsedExternalSourceId" ||
        // Legacy key used before the field was renamed. Read it as a fallback
        // so existing installs keep their remembered source on first load.
        key === "primaryExternalSourceId"
      ) {
        const normalized = normalizeLastUsedExternalSourceId(setting.value);
        if (
          normalized !== undefined &&
          generalSettings.lastUsedExternalSourceId === undefined
        ) {
          generalSettings.lastUsedExternalSourceId = normalized;
        }
        continue;
      }

      assignGeneralSetting(generalSettings, key, setting.value);
    }

    return generalSettings;
  }

  async updateGeneralSettings(
    input: UpdateGeneralSettingsInput,
    userIdValue: number | string,
  ): Promise<GeneralSettings> {
    const userId = normalizeUserId(userIdValue);
    const { lastUsedExternalSourceId, ...otherGeneralSettings } = input;

    if (lastUsedExternalSourceId !== undefined) {
      const normalizedLastUsedExternalSourceId =
        normalizeLastUsedExternalSourceId(lastUsedExternalSourceId);

      if (normalizedLastUsedExternalSourceId !== undefined) {
        await this.settingRepository.upsert(
          "general.lastUsedExternalSourceId",
          normalizedLastUsedExternalSourceId,
          "string",
          userId,
        );
      } else {
        await this.settingRepository.remove("general.lastUsedExternalSourceId");
      }
      // Always drop the legacy row so a stale fallback can't resurrect
      // after the user clears or changes their selection.
      await this.settingRepository.remove("general.primaryExternalSourceId");
    }

    const updates = settingUpdates("general", otherGeneralSettings, userId);

    if (updates.length > 0) {
      await this.settingRepository.upsertMany(updates);
    }

    return this.getGeneralSettings();
  }

  async getSecurityPolicy(): Promise<SecurityPolicy> {
    const settings = await this.settingRepository.findByKeyPrefix("security.");

    const securityPolicy: SecurityPolicy = {
      passwordMinLength: 8,
      passwordRequireUppercase: true,
      passwordRequireLowercase: true,
      passwordRequireNumbers: true,
      passwordRequireSpecialChars: true,
      passwordExpirationDays: 90,
      sessionTimeoutMinutes: 30,
      rememberMeExpiryHours: 336,
      maxLoginAttempts: 5,
      lockoutDurationMinutes: 30,
      twoFactorRequired: false,
      twoFactorGracePeriodDays: 30,
      twoFactorEnabledDate: undefined,
      twoFactorEnforcementMode: "warn",
      ipWhitelistEnabled: false,
      ipWhitelist: [],
    };

    for (const setting of settings) {
      const key = setting.key.replace("security.", "");
      assignSecurityPolicySetting(securityPolicy, key, setting.value);
    }

    if (
      securityPolicy.twoFactorRequired &&
      securityPolicy.twoFactorEnabledDate === undefined
    ) {
      securityPolicy.twoFactorEnabledDate = new Date().toISOString();
    }

    return securityPolicy;
  }

  async updateSecurityPolicy(
    input: UpdateSecurityPolicyInput,
    userIdValue: number | string,
  ): Promise<SecurityPolicy> {
    const userId = normalizeUserId(userIdValue);
    const currentPolicy = await this.getSecurityPolicy();

    if (input.twoFactorRequired !== undefined) {
      if (input.twoFactorRequired && !currentPolicy.twoFactorRequired) {
        await this.settingRepository.upsert(
          "security.twoFactorEnabledDate",
          new Date().toISOString(),
          "string",
          userId,
          "Timestamp when 2FA requirement was enabled",
        );
      } else if (!input.twoFactorRequired) {
        await this.settingRepository.remove("security.twoFactorEnabledDate");
      }
    }

    const updates = settingUpdates("security", input, userId);

    if (updates.length > 0) {
      await this.settingRepository.upsertMany(updates);
    }

    return this.getSecurityPolicy();
  }

  async getNotificationSettings(): Promise<NotificationSettings> {
    const settings =
      await this.settingRepository.findByKeyPrefix("notifications.");

    const notificationSettings: NotificationSettings = {
      emailEnabled: true,
      emailServer: "localhost",
      emailPort: 587,
      emailSecure: false,
      emailFrom: "noreply@bitsentry.local",
      slackEnabled: false,
      teamsEnabled: false,
      webhookEnabled: false,
    };

    for (const setting of settings) {
      const key = setting.key.replace("notifications.", "");
      assignNotificationSetting(notificationSettings, key, setting.value);
    }

    return notificationSettings;
  }

  async updateNotificationSettings(
    input: UpdateNotificationSettingsInput,
    userIdValue: number | string,
  ): Promise<NotificationSettings> {
    const userId = normalizeUserId(userIdValue);
    const updates = settingUpdates("notifications", input, userId);

    if (updates.length > 0) {
      await this.settingRepository.upsertMany(updates);
    }

    return this.getNotificationSettings();
  }

  async getAlertRules(): Promise<AlertRule[]> {
    const settings =
      await this.settingRepository.findByKeyPrefix("alertRules.");
    const rulesMap = new Map<string, AlertRule>();

    for (const setting of settings) {
      const match = setting.key.match(/^alertRules\.(.+)$/);
      if (match === null) {
        continue;
      }

      const ruleId = match[1];
      const rule = alertRuleValue(setting.value);
      if (rule !== undefined) {
        rulesMap.set(ruleId, rule);
      }
    }

    return Array.from(rulesMap.values());
  }

  async createAlertRule(
    rule: Omit<AlertRule, "id">,
    userIdValue: number | string,
  ): Promise<AlertRule> {
    const userId = normalizeUserId(userIdValue);
    const ruleId = `rule_${String(Date.now())}`;
    const fullRule: AlertRule = {
      id: ruleId,
      ...rule,
    };

    await this.settingRepository.upsert(
      `alertRules.${ruleId}`,
      fullRule,
      "json",
      userId,
      `Alert rule: ${rule.name}`,
    );

    return fullRule;
  }

  async updateAlertRule(
    ruleId: string,
    input: UpdateAlertRuleInput,
    userIdValue: number | string,
  ): Promise<AlertRule> {
    const userId = normalizeUserId(userIdValue);
    const existing = await this.settingRepository.findByKey(
      `alertRules.${ruleId}`,
    );

    if (existing === null) {
      throw new Error(`Alert rule ${ruleId} not found`);
    }

    const existingRule = alertRuleValue(existing.value);
    if (existingRule === undefined) {
      throw new Error(`Alert rule ${ruleId} is invalid`);
    }

    const updatedRule: AlertRule = {
      ...existingRule,
      ...input,
      id: ruleId,
    };

    await this.settingRepository.upsert(
      `alertRules.${ruleId}`,
      updatedRule,
      "json",
      userId,
    );

    return updatedRule;
  }

  deleteAlertRule(ruleId: string): Promise<void> {
    return this.settingRepository.remove(`alertRules.${ruleId}`);
  }
}
