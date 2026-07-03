import type { DesktopCodePlugin } from "@bitsentry-ce/core/features/plugins";

function readString(value, fallback = "") {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return fallback;
}

function readRecord(value): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value;
}

function readRecordOrEmpty(value): Record<string, unknown> {
  return readRecord(value) ?? {};
}

function resolveWazuhIndexUrl(value) {
  const parsed = new URL(requireString(value, "indexUrl"));
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Wazuh index URL must use http:// or https://");
  }

  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

function readStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function resolveWazuhErrorSourceSetup(context) {
  const setupValues = readRecordOrEmpty(context.setupValues);
  const indexUrl = readString(setupValues.indexUrl);
  const indexPassword = readString(setupValues.indexPassword);
  const indexPatterns = readStringArray(setupValues.indexPatterns);
  const configuration: Record<string, unknown> = {};
  if (indexUrl.length > 0) {
    configuration.baseUrl = indexUrl;
  }
  if (indexPatterns.length > 0) {
    configuration.indexPatterns = indexPatterns;
  }

  return {
    accessTokenRef: indexPassword.length > 0 ? indexPassword : undefined,
    configuration,
  };
}

function buildWazuhErrorSourceAuthFromParts(accessTokenRef, configuration) {
  const config = readRecordOrEmpty(configuration);
  const auth = { ...config };
  const baseUrl = readString(config.baseUrl);
  if (baseUrl.length > 0) {
    auth.indexUrl = baseUrl;
  }
  const indexPassword = readString(accessTokenRef);
  if (indexPassword.length > 0) {
    auth.indexPassword = indexPassword;
  }

  return auth;
}

function buildWazuhErrorSourceAuth(context) {
  const source = readRecordOrEmpty(context.source);
  return buildWazuhErrorSourceAuthFromParts(
    source.accessTokenRef,
    source.configuration,
  );
}

function buildWazuhErrorSourceProbeAuth(context) {
  const persistedSetup = readRecordOrEmpty(context.persistedSetup);
  return buildWazuhErrorSourceAuthFromParts(
    persistedSetup.accessTokenRef,
    persistedSetup.configuration,
  );
}

function readIsoTimestamp(value) {
  const raw = readString(value);
  const parsed = new Date(raw);
  if (Number.isFinite(parsed.getTime())) {
    return parsed.toISOString();
  }

  return new Date().toISOString();
}

function readCursorOffset(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return 0;
}

function readPositiveInteger(value, fallback) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  return fallback;
}

function readNonNegativeInteger(value, fallback) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }

  return fallback;
}

function readWazuhSourceRecord(hit) {
  return readRecord(hit?._source);
}

function readWazuhRuleRecord(hit) {
  return readRecord(readWazuhSourceRecord(hit)?.rule);
}

function readWazuhAgentRecord(hit) {
  return readRecord(readWazuhSourceRecord(hit)?.agent);
}

function readWazuhManagerRecord(hit) {
  return readRecord(readWazuhSourceRecord(hit)?.manager);
}

function readWazuhDescription(hit) {
  const ruleDescription = readString(readWazuhRuleRecord(hit)?.description);
  if (ruleDescription.length > 0) {
    return ruleDescription;
  }

  const fullLog = readString(readWazuhSourceRecord(hit)?.full_log);
  if (fullLog.length > 0) {
    return fullLog;
  }

  return "Wazuh alert";
}

function readWazuhLevelText(hit) {
  const rawLevel = Number(readWazuhRuleRecord(hit)?.level);
  if (!Number.isFinite(rawLevel)) {
    return "warning";
  }

  if (rawLevel >= 12) return "fatal";
  if (rawLevel >= 8) return "error";
  if (rawLevel >= 4) return "warning";
  return "info";
}

function buildWazuhTags(hit) {
  const source = readWazuhSourceRecord(hit);
  const rule = readWazuhRuleRecord(hit);
  const agent = readWazuhAgentRecord(hit);
  const manager = readWazuhManagerRecord(hit);
  const decoder = readRecord(source?.decoder);
  const tags: Record<string, unknown> = {};

  const ruleId = readString(rule?.id);
  if (ruleId.length > 0) tags.ruleId = ruleId;
  if (rule?.level !== undefined) tags.ruleLevel = rule.level;
  const ruleDescription = readString(rule?.description);
  if (ruleDescription.length > 0) tags.ruleDescription = ruleDescription;
  const agentId = readString(agent?.id);
  if (agentId.length > 0) tags.agentId = agentId;
  const agentName = readString(agent?.name);
  if (agentName.length > 0) tags.agentName = agentName;
  const managerName = readString(manager?.name);
  if (managerName.length > 0) tags.managerName = managerName;
  const location = readString(source?.location);
  if (location.length > 0) tags.location = location;
  const decoderName = readString(decoder?.name);
  if (decoderName.length > 0) tags.decoderName = decoderName;

  return tags;
}

function mapAlertToIssue(hit) {
  const externalId = readString(hit?._id);
  if (externalId.length === 0) {
    return undefined;
  }

  const source = readWazuhSourceRecord(hit);
  const rule = readWazuhRuleRecord(hit);
  const agent = readWazuhAgentRecord(hit);
  const manager = readWazuhManagerRecord(hit);
  const timestamp = readIsoTimestamp(source?.["@timestamp"]);
  const title = readWazuhDescription(hit);
  const fullLog = readString(source?.full_log, title);
  const agentName = readString(agent?.name);
  const managerName = readString(manager?.name);

  return {
    id: externalId,
    externalIssueId: externalId,
    latestEventId: externalId,
    title,
    message: fullLog,
    culprit: agentName || readString(source?.location),
    type: readString(rule?.id),
    metadata: rule,
    projectIdentifier: readString(hit?._index),
    level: readWazuhLevelText(hit),
    status: "unresolved",
    isUnhandled: true,
    firstSeen: timestamp,
    lastSeen: timestamp,
    timestamp,
    eventCount: 1,
    userCount: null,
    tags: buildWazuhTags(hit),
    environment: managerName,
    platform: "wazuh",
    contexts: source,
    user: agent,
    serverName: agentName || managerName,
    transactionName: readString(source?.location),
    rawAlert: hit,
  };
}

function requireString(value, fieldName) {
  const normalized = readString(value);
  if (normalized.length === 0) {
    throw new Error(`${fieldName} is required`);
  }

  return normalized;
}

function buildQuery(input) {
  const must = [];
  const query = readString(input.query, "*");
  if (query === "*") {
    must.push({ match_all: {} });
  } else {
    must.push({
      query_string: {
        query,
      },
    });
  }

  const range: Record<string, string> = {};
  const since = readString(input.since);
  const until = readString(input.until);
  if (since.length > 0) {
    range.gte = since;
  }
  if (until.length > 0) {
    range.lte = until;
  }
  if (Object.keys(range).length > 0) {
    must.push({
      range: {
        "@timestamp": range,
      },
    });
  }

  return {
    bool: {
      must,
    },
  };
}

function readTotalHits(payload, fallback) {
  const total = payload?.hits?.total;
  if (typeof total === "number") {
    return total;
  }

  if (typeof total?.value === "number") {
    return total.value;
  }

  return fallback;
}

function formatOutput(input) {
  const lines = [
    "Wazuh alerts",
    `Index: ${input.indexPattern}`,
    `Query: ${input.query}`,
    `Results: ${String(input.items.length)}${input.hasMore ? "+" : ""}`,
  ];

  for (const hit of input.items.slice(0, 10)) {
    const source = hit._source;
    const timestamp = readString(source?.["@timestamp"], "unknown time");
    const description =
      readString(source?.rule?.description) ||
      readString(source?.full_log) ||
      "Wazuh alert";
    lines.push(`- ${timestamp} ${description}`);
  }

  if (input.hasMore) {
    lines.push("More results available.");
  }

  return lines.join("\n");
}

async function searchAlerts({ auth, input }) {
  const indexUrl = resolveWazuhIndexUrl(auth.indexUrl);
  const indexUsername = readString(auth.indexUsername, "admin");
  const indexPassword = requireString(auth.indexPassword, "indexPassword");
  const indexPattern = readString(input.indexPattern, "wazuh-alerts-*");
  const query = readString(input.query, "*");
  const limit = Math.min(readPositiveInteger(input.limit, 20), 100);
  const offset = readNonNegativeInteger(input.offset, 0);
  const credentials = Buffer.from(
    `${indexUsername}:${indexPassword}`,
  ).toString("base64");
  const response = await fetch(`${indexUrl}/${indexPattern}/_search`, {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: buildQuery(input),
      size: limit,
      from: offset,
      sort: [
        {
          "@timestamp": {
            order: "desc",
          },
        },
      ],
    }),
  });

  if (!response.ok) {
    if (response.status === 404) {
      return {
        ok: true,
        status: 200,
        summary: "Fetched 0 Wazuh alerts.",
        data: {
          items: [],
          hasMore: false,
          total: 0,
          output: "Wazuh alerts\nResults: 0",
        },
      };
    }

    const body = await response
      .text()
      .catch(() => "Unable to read error response");
    throw new Error(
      `Wazuh search failed: ${String(response.status)} ${response.statusText} - ${body}`,
    );
  }

  const payload = await response.json();
  const items = Array.isArray(payload?.hits?.hits) ? payload.hits.hits : [];
  const total = readTotalHits(payload, items.length);
  const hasMore = offset + items.length < total;

  return {
    ok: true,
    status: 200,
    summary: `Fetched ${String(items.length)} Wazuh alerts.`,
    data: {
      items,
      hasMore,
      total,
      output: formatOutput({
        indexPattern,
        query,
        items,
        hasMore,
      }),
    },
  };
}

async function queryIssues(context) {
  const offset = readCursorOffset(context.input.cursor);
  const result = await searchAlerts({
    auth: context.auth,
    input: {
      ...context.input,
      offset,
    },
  });
  const data = readRecord(result.data) ?? {};
  const items = Array.isArray(data.items) ? data.items : [];
  const issues = items
    .map((item) => mapAlertToIssue(item))
    .filter((item) => item !== undefined);
  const hasMore = data.hasMore === true && items.length > 0;

  return {
    ...result,
    summary: `Fetched ${String(issues.length)} Wazuh issues.`,
    data: {
      issues,
      hasMore,
      nextCursor: hasMore ? String(offset + items.length) : undefined,
      total: data.total,
      output: data.output,
    },
  };
}

const plugin: DesktopCodePlugin = {
  id: "wazuh",
  name: "Wazuh",
  version: "0.1.0",
  description: "Queries Wazuh/OpenSearch alert indexes as a local code plugin.",
  metadata: {
    errorSource: {
      sourceType: "wazuh",
      setupFields: [
        {
          key: "indexUrl",
          label: "Wazuh index URL",
          placeholder: "https://wazuh.example.com:9200",
          description: "OpenSearch/Indexer base URL for Wazuh alerts.",
          required: false,
          control: "text",
        },
        {
          key: "indexPassword",
          label: "Wazuh index password",
          description:
            "Password for the Wazuh index user. The username defaults to admin.",
          required: false,
          control: "password",
        },
        {
          key: "indexPatterns",
          label: "Index patterns",
          placeholder: "wazuh-alerts-*",
          description: "Comma or newline separated Wazuh index patterns.",
          required: false,
          control: "multiline_list",
        },
      ],
    },
  },
  errorSource: {
    resolveSetup: resolveWazuhErrorSourceSetup,
    buildAuth: buildWazuhErrorSourceAuth,
    buildProbeAuth: buildWazuhErrorSourceProbeAuth,
  },
  auth: {
    fields: [
      {
        key: "indexUrl",
        label: "Wazuh index URL",
        type: "string",
        required: true,
      },
      {
        key: "indexUsername",
        label: "Wazuh index username",
        type: "string",
        required: true,
        defaultValue: "admin",
      },
      {
        key: "indexPassword",
        label: "Wazuh index password",
        type: "string",
        required: true,
        secret: true,
      },
    ],
  },
  actions: [
    {
      id: "query_issues",
      title: "Query Wazuh issues",
      description:
        "Search Wazuh/OpenSearch alerts and return normalized issue records for sync.",
      riskLevel: "read",
      fields: [
        {
          key: "query",
          label: "Query",
          type: "string",
          required: false,
          defaultValue: "*",
        },
        {
          key: "indexPattern",
          label: "Index pattern",
          type: "string",
          required: false,
          defaultValue: "wazuh-alerts-*",
        },
        {
          key: "limit",
          label: "Limit",
          type: "number",
          required: false,
          defaultValue: 20,
        },
        {
          key: "cursor",
          label: "Cursor",
          type: "string",
          required: false,
        },
        {
          key: "since",
          label: "Since",
          type: "string",
          required: false,
        },
        {
          key: "until",
          label: "Until",
          type: "string",
          required: false,
        },
      ],
      execute: queryIssues,
    },
    {
      id: "search_alerts",
      title: "Search Wazuh alerts",
      description: "Search Wazuh/OpenSearch alerts and return raw hits.",
      riskLevel: "read",
      fields: [
        {
          key: "query",
          label: "Query",
          type: "string",
          required: false,
          defaultValue: "*",
        },
        {
          key: "indexPattern",
          label: "Index pattern",
          type: "string",
          required: false,
          defaultValue: "wazuh-alerts-*",
        },
        {
          key: "limit",
          label: "Limit",
          type: "number",
          required: false,
          defaultValue: 20,
        },
        {
          key: "offset",
          label: "Offset",
          type: "number",
          required: false,
          defaultValue: 0,
        },
        {
          key: "since",
          label: "Since",
          type: "string",
          required: false,
        },
        {
          key: "until",
          label: "Until",
          type: "string",
          required: false,
        },
      ],
      execute: searchAlerts,
    },
  ],
};

export { plugin };
export default plugin;
