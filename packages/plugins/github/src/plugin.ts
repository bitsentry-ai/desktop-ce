import type { DesktopCodePlugin } from "@bitsentry-ce/core/features/plugins";

const GITHUB_API_BASE = "https://api.github.com";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function readRecord(value): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value;
}

function readString(value, fallback = "") {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value).trim();
  }

  return fallback;
}

function readStringArray(value) {
  if (Array.isArray(value)) {
    return value
      .filter((item) => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  if (typeof value === "string") {
    return value
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  return [];
}

function boundedLimit(value, fallback = DEFAULT_LIMIT) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(value)));
  }

  const numeric = Number(readString(value));
  if (Number.isFinite(numeric)) {
    return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(numeric)));
  }

  return fallback;
}

function readCursorPage(value) {
  const numeric = Number(readString(value, "1"));
  if (!Number.isFinite(numeric) || numeric < 1) {
    return 1;
  }

  return Math.trunc(numeric);
}

function resolveGitHubApiBase(value) {
  const normalized = readString(value, GITHUB_API_BASE);
  const parsed = new URL(normalized);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("GitHub API base URL must use http:// or https://");
  }

  return parsed.origin + parsed.pathname.replace(/\/$/, "");
}

function encodePathSegment(value) {
  const normalized = readString(value);
  if (normalized.length === 0) {
    throw new Error("GitHub path segment cannot be empty");
  }

  return encodeURIComponent(normalized);
}

function buildGitHubUrl(apiBase, pathname, params = {}) {
  const url = new URL(`${resolveGitHubApiBase(apiBase)}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || readString(value).length === 0) {
      continue;
    }

    url.searchParams.set(key, readString(value));
  }

  return url.toString();
}

function parseGitHubErrorBody(raw) {
  if (raw.length === 0) {
    return "Unknown GitHub API error";
  }

  try {
    const body = JSON.parse(raw);
    const message = readString(body.message);
    if (message.length > 0) {
      return message;
    }
  } catch {
    // Fall back to the raw response body below.
  }

  return raw;
}

async function requestGitHubJson(auth, pathname, params = {}, options = {}) {
  const accessToken = readString(auth.accessToken ?? auth.authToken ?? auth.token);
  const apiBase = auth.apiBase ?? auth.baseUrl;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "bitsentry-superterminal-plugin",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (accessToken.length > 0) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  const requestBody = readRecord(options).body;
  if (requestBody !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const requestInit = {
    method: readString(readRecord(options).method, "GET"),
    headers,
  };
  if (requestBody !== undefined) {
    Object.assign(requestInit, {
      body: JSON.stringify(requestBody),
    });
  }

  const response = await fetch(buildGitHubUrl(apiBase, pathname, params), requestInit);
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(
      `GitHub API ${String(response.status)}: ${parseGitHubErrorBody(responseBody)}`,
    );
  }

  if (responseBody.trim().length === 0) {
    return {
      status: response.status,
      data: null,
    };
  }

  return {
    status: response.status,
    data: JSON.parse(responseBody),
  };
}

async function requestGitHub(auth, pathname, params = {}) {
  const result = await requestGitHubJson(auth, pathname, params);
  return result.data;
}

function isGitHubNotFoundError(error) {
  return error instanceof Error && error.message.includes("GitHub API 404:");
}

function normalizeGitHubIssue(owner, repo, issue) {
  const record = readRecord(issue);
  const number = readString(record.number);
  const htmlUrl = readString(record.html_url);
  const commentCount = Number(record.comments);
  const labels = Array.isArray(record.labels)
    ? record.labels
        .map((label) => readString(readRecord(label).name))
        .filter((label) => label.length > 0)
    : [];
  const isPullRequest = readRecord(record.pull_request).url !== undefined;
  const externalIssueId = `${owner}/${repo}#${number}`;

  return {
    id: externalIssueId,
    externalIssueId,
    externalShortId: `#${number}`,
    title: readString(record.title, "Untitled GitHub issue"),
    message: readString(record.body),
    status: readString(record.state, "open"),
    state: readString(record.state, "open"),
    level: readString(record.state, "open") === "open" ? "error" : "info",
    type: isPullRequest ? "pull_request" : "issue",
    platform: "github",
    projectIdentifier: `${owner}/${repo}`,
    createdAt: readString(record.created_at),
    updatedAt: readString(record.updated_at),
    lastSeen: readString(record.updated_at, readString(record.created_at)),
    eventCount: Number.isFinite(commentCount) ? commentCount + 1 : 1,
    url: htmlUrl,
    tags: labels.map((label) => ({ key: "label", value: label })),
    metadata: {
      owner,
      repo,
      number,
      htmlUrl,
      labels,
      user: readString(readRecord(record.user).login),
    },
  };
}

function normalizeRepository(value) {
  const repo = readRecord(value);
  const owner = readRecord(repo.owner);
  const name = readString(repo.name);
  const fullName = readString(repo.full_name, name);

  return {
    id: fullName,
    slug: name,
    name: fullName,
    organizationId: readString(owner.login),
  };
}

function resolveOwner(input, auth) {
  const owner = readString(input.owner, readString(input.orgSlug, readString(auth.orgSlug)));
  if (owner.length === 0) {
    throw new Error("GitHub owner or organization is required");
  }

  return owner;
}

function resolveRepos(input, auth) {
  const directRepo = readString(input.repo);
  if (directRepo.length > 0) {
    return [directRepo];
  }

  const projectIds = readStringArray(input.projectIds);
  if (projectIds.length > 0) {
    return projectIds;
  }

  const configured = readStringArray(auth.projectIds ?? auth.repos);
  if (configured.length > 0) {
    return configured;
  }

  throw new Error("GitHub repository is required");
}

function buildIssueParams(input, limit, page) {
  const labels = readStringArray(input.labels).join(",");
  const params = {
    state: readString(input.state, "open"),
    sort: readString(input.sort, "updated"),
    direction: readString(input.direction, "desc"),
    labels,
    since: readString(input.since),
    per_page: String(limit + 1),
    page: String(page),
  };

  if (params.state !== "open" && params.state !== "closed" && params.state !== "all") {
    params.state = "open";
  }

  return params;
}

async function listIssuesForRepo(auth, owner, repo, input) {
  const limit = boundedLimit(input.limit);
  const page = readCursorPage(input.cursor);
  const issues = await requestGitHub(
    auth,
    `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues`,
    buildIssueParams(input, limit, page),
  );
  const records = Array.isArray(issues)
    ? issues.map((issue) => normalizeGitHubIssue(owner, repo, issue))
    : [];

  return {
    issues: records.slice(0, limit),
    hasMore: records.length > limit,
    nextCursor: records.length > limit ? String(page + 1) : undefined,
  };
}

async function listGitHubIssues(context) {
  const auth = readRecord(context.auth);
  const input = readRecord(context.input);
  const owner = resolveOwner(input, auth);
  const repos = resolveRepos(input, auth);
  const pages = [];

  for (const repo of repos) {
    pages.push(await listIssuesForRepo(auth, owner, repo, input));
  }

  const issues = pages.flatMap((page) => page.issues);
  const hasMore = pages.some((page) => page.hasMore);
  const nextCursor = pages.find((page) => page.nextCursor !== undefined)?.nextCursor;

  return {
    status: 200,
    summary: `Fetched ${String(issues.length)} GitHub issues.`,
    data: {
      issues,
      hasMore,
      nextCursor,
    },
  };
}

function buildSearchQuery(input, owner, repo) {
  const query = readString(input.query);
  const normalizedQuery = query.length === 0 || query === "*" ? "is:issue" : query;

  return `repo:${owner}/${repo} ${normalizedQuery}`;
}

async function queryGitHubIssues(context) {
  const auth = readRecord(context.auth);
  const input = readRecord(context.input);
  const owner = resolveOwner(input, auth);
  const repos = resolveRepos(input, auth);
  const limit = boundedLimit(input.limit);
  const page = readCursorPage(input.cursor);
  const issues = [];
  let hasMore = false;

  for (const repo of repos) {
    const result = await requestGitHub(auth, "/search/issues", {
      q: buildSearchQuery(input, owner, repo),
      sort: "updated",
      order: "desc",
      per_page: String(limit + 1),
      page: String(page),
    });
    const resultItems = readRecord(result).items;
    const items: unknown[] = Array.isArray(resultItems) ? resultItems : [];
    for (const item of items.slice(0, limit)) {
      issues.push(normalizeGitHubIssue(owner, repo, item));
    }
    hasMore = hasMore || items.length > limit;
  }

  return {
    status: 200,
    summary: `Fetched ${String(issues.length)} GitHub issues.`,
    data: {
      issues,
      hasMore,
      nextCursor: hasMore ? String(page + 1) : undefined,
    },
  };
}

function buildCreateIssueBody(input) {
  const title = readString(input.title);
  if (title.length === 0) {
    throw new Error("GitHub issue title is required");
  }

  const body: Record<string, unknown> = {
    title,
  };
  const description = readString(input.body);
  if (description.length > 0) {
    body.body = description;
  }
  const labels = readStringArray(input.labels);
  if (labels.length > 0) {
    body.labels = labels;
  }
  const assignees = readStringArray(input.assignees);
  if (assignees.length > 0) {
    body.assignees = assignees;
  }
  const milestone = readString(input.milestone);
  if (milestone.length > 0) {
    const numericMilestone = Number(milestone);
    if (!Number.isFinite(numericMilestone)) {
      throw new Error("GitHub issue milestone must be a number");
    }
    body.milestone = Math.trunc(numericMilestone);
  }

  return body;
}

async function createGitHubIssue(context) {
  const auth = readRecord(context.auth);
  const input = readRecord(context.input);
  const owner = resolveOwner(input, auth);
  const repo = resolveRepos(input, auth)[0];
  const pathname = `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues`;
  const result = await requestGitHubJson(auth, pathname, {}, {
    method: "POST",
    body: buildCreateIssueBody(input),
  });

  return {
    status: result.status,
    summary: `POST ${pathname} completed successfully.`,
    data: result.data,
  };
}

async function listGitHubOrganizations(context) {
  const auth = readRecord(context.auth);
  const orgs = await requestGitHub(auth, "/user/orgs", { per_page: "100" });
  const data = Array.isArray(orgs)
    ? orgs.map((org) => {
        const record = readRecord(org);
        const slug = readString(record.login, readString(record.id));
        return {
          slug,
          name: readString(record.name, slug),
        };
      })
    : [];

  return {
    status: 200,
    summary: `Fetched ${String(data.length)} GitHub organizations.`,
    data,
  };
}

async function listGitHubProjects(context) {
  const auth = readRecord(context.auth);
  const input = readRecord(context.input);
  const owner = resolveOwner(input, auth);
  let repos;
  try {
    repos = await requestGitHub(
      auth,
      `/orgs/${encodePathSegment(owner)}/repos`,
      {
        type: "all",
        per_page: "100",
      },
    );
  } catch (error) {
    if (!isGitHubNotFoundError(error)) {
      throw error;
    }

    repos = await requestGitHub(
      auth,
      `/users/${encodePathSegment(owner)}/repos`,
      {
        type: "all",
        per_page: "100",
      },
    );
  }
  const data = Array.isArray(repos) ? repos.map(normalizeRepository) : [];

  return {
    status: 200,
    summary: `Fetched ${String(data.length)} GitHub repositories.`,
    data,
  };
}

function resolveGitHubErrorSourceSetup(context) {
  const setupValues = readRecord(context.setupValues);
  const accessToken = readString(setupValues.accessToken);
  const owner = readString(setupValues.owner);
  const repos = readStringArray(setupValues.repos);
  const apiBase = readString(setupValues.apiBase);
  const configuration: Record<string, unknown> = {};

  if (owner.length > 0) {
    configuration.orgSlug = owner;
  }
  if (repos.length > 0) {
    configuration.projectIds = repos;
  }
  if (apiBase.length > 0) {
    configuration.baseUrl = apiBase;
  }

  return {
    accessTokenRef: accessToken.length > 0 ? accessToken : undefined,
    configuration,
  };
}

function buildGitHubErrorSourceAuthFromParts(accessTokenRef, configuration) {
  const config = readRecord(configuration);
  const auth = { ...config };
  const accessToken = readString(accessTokenRef);
  if (accessToken.length > 0) {
    auth.accessToken = accessToken;
    auth.authToken = accessToken;
  }
  if (Array.isArray(config.projectIds)) {
    auth.repos = config.projectIds;
  }

  return auth;
}

function buildGitHubErrorSourceAuth(context) {
  const source = readRecord(context.source);
  return buildGitHubErrorSourceAuthFromParts(
    source.accessTokenRef,
    source.configuration,
  );
}

function buildGitHubErrorSourceProbeAuth(context) {
  const persistedSetup = readRecord(context.persistedSetup);
  return buildGitHubErrorSourceAuthFromParts(
    persistedSetup.accessTokenRef,
    persistedSetup.configuration,
  );
}

const plugin: DesktopCodePlugin = {
  id: "github",
  name: "GitHub",
  version: "0.1.0",
  description: "Queries GitHub repositories and issues as a local code plugin.",
  referenceRepositoryPath: ".repos/references/plugins/stackstorm-github",
  metadata: {
    errorSource: {
      sourceType: "github",
      setupFields: [
        {
          key: "accessToken",
          label: "GitHub token",
          description: "Personal access token or fine-grained token for GitHub.",
          required: true,
          control: "password",
        },
        {
          key: "owner",
          label: "Owner or organization",
          placeholder: "bitsentry-ai",
          required: true,
          control: "text",
        },
        {
          key: "repos",
          label: "Repositories",
          placeholder: "monorepo\nrunbooks",
          description: "Repository names to ingest issues from.",
          required: true,
          control: "multiline_list",
        },
        {
          key: "apiBase",
          label: "GitHub API base URL",
          placeholder: GITHUB_API_BASE,
          required: false,
          control: "text",
        },
      ],
    },
  },
  errorSource: {
    resolveSetup: resolveGitHubErrorSourceSetup,
    buildAuth: buildGitHubErrorSourceAuth,
    buildProbeAuth: buildGitHubErrorSourceProbeAuth,
  },
  auth: {
    fields: [
      {
        key: "accessToken",
        label: "GitHub token",
        type: "string",
        required: false,
        secret: true,
      },
      {
        key: "apiBase",
        label: "GitHub API base URL",
        type: "string",
        required: false,
        defaultValue: GITHUB_API_BASE,
      },
    ],
  },
  actions: [
    {
      id: "list_organizations",
      title: "List GitHub organizations",
      description: "List organizations visible to the GitHub token.",
      riskLevel: "read",
      fields: [],
      execute: listGitHubOrganizations,
    },
    {
      id: "list_projects",
      title: "List GitHub repositories",
      description: "List repositories for a GitHub organization.",
      riskLevel: "read",
      fields: [
        {
          key: "orgSlug",
          label: "Owner or organization",
          type: "string",
          required: true,
        },
      ],
      execute: listGitHubProjects,
    },
    {
      id: "list_issues",
      title: "List GitHub issues",
      description:
        "Retrieve issues for one or more repositories, similar to StackStorm's list_issues action.",
      riskLevel: "read",
      fields: [
        {
          key: "owner",
          label: "Owner or organization",
          type: "string",
          required: false,
        },
        {
          key: "repo",
          label: "Repository",
          type: "string",
          required: false,
        },
        {
          key: "state",
          label: "State",
          type: "string",
          required: false,
          enumValues: ["open", "closed", "all"],
          defaultValue: "open",
        },
        {
          key: "labels",
          label: "Labels",
          type: "string_array",
          required: false,
        },
        {
          key: "since",
          label: "Updated since",
          type: "string",
          required: false,
        },
        {
          key: "limit",
          label: "Limit",
          type: "number",
          required: false,
          defaultValue: DEFAULT_LIMIT,
        },
        {
          key: "cursor",
          label: "Cursor",
          type: "string",
          required: false,
        },
      ],
      execute: listGitHubIssues,
    },
    {
      id: "query_issues",
      title: "Query GitHub issues",
      description: "Search GitHub issues using GitHub search qualifiers.",
      riskLevel: "read",
      fields: [
        {
          key: "owner",
          label: "Owner or organization",
          type: "string",
          required: false,
        },
        {
          key: "repo",
          label: "Repository",
          type: "string",
          required: false,
        },
        {
          key: "query",
          label: "Search query",
          type: "string",
          required: false,
          defaultValue: "is:issue is:open",
        },
        {
          key: "limit",
          label: "Limit",
          type: "number",
          required: false,
          defaultValue: DEFAULT_LIMIT,
        },
        {
          key: "cursor",
          label: "Cursor",
          type: "string",
          required: false,
        },
      ],
      execute: queryGitHubIssues,
    },
    {
      id: "create_issue",
      title: "Create GitHub issue",
      description:
        "Create an issue in a GitHub repository as executable plugin-owned code.",
      riskLevel: "write",
      fields: [
        {
          key: "owner",
          label: "Owner or organization",
          type: "string",
          required: false,
        },
        {
          key: "repo",
          label: "Repository",
          type: "string",
          required: true,
        },
        {
          key: "title",
          label: "Title",
          type: "string",
          required: true,
        },
        {
          key: "body",
          label: "Body",
          type: "string",
          required: false,
        },
        {
          key: "labels",
          label: "Labels",
          type: "string_array",
          required: false,
        },
        {
          key: "assignees",
          label: "Assignees",
          type: "string_array",
          required: false,
        },
        {
          key: "milestone",
          label: "Milestone number",
          type: "string",
          required: false,
        },
      ],
      execute: createGitHubIssue,
    },
  ],
  triggers: [],
};

export { plugin };
export default plugin;
