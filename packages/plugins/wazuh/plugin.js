function readString(value, fallback = "") {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return fallback;
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

  const range = {};
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
  const indexUrl = requireString(auth.indexUrl, "indexUrl").replace(/\/+$/, "");
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

exports.plugin = {
  id: "wazuh",
  name: "Wazuh",
  version: "0.1.0",
  description: "Queries Wazuh/OpenSearch alert indexes as a local code plugin.",
  metadata: {
    errorSource: {
      sourceType: "wazuh",
      setupFields: [
        {
          key: "baseUrl",
          target: "baseUrl",
          storage: "configuration",
          configurationKey: "baseUrl",
          label: "Wazuh index URL",
          placeholder: "https://wazuh.example.com:9200",
          description: "OpenSearch/Indexer base URL for Wazuh alerts.",
          required: false,
          control: "text",
        },
        {
          key: "indexPassword",
          target: "authToken",
          storage: "accessTokenRef",
          label: "Wazuh index password",
          description:
            "Password for the Wazuh index user. The username defaults to admin.",
          required: false,
          control: "password",
        },
        {
          key: "indexPatterns",
          target: "indexPatterns",
          storage: "configuration",
          configurationKey: "indexPatterns",
          label: "Index patterns",
          placeholder: "wazuh-alerts-*",
          description: "Comma or newline separated Wazuh index patterns.",
          required: false,
          control: "multiline_list",
        },
      ],
      providerActions: {
        searchAlerts: "search_alerts",
      },
    },
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
  triggers: [],
};
