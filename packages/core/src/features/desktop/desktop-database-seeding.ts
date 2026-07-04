type SeedRow = Record<string, unknown>

type CreateModel = {
  create(args: { data: SeedRow }): Promise<unknown>
}

type SettingRecord = {
  key?: unknown
  value?: unknown
}

type RunbookActionRecord = {
  id?: unknown
  title?: unknown
  prompt?: unknown
  llmProviderKey?: unknown
  llmModel?: unknown
}

export type DesktopDatabaseSeedClient = {
  role: {
    findUnique(args: { where: { id: number } }): Promise<unknown>
    create(args: { data: { id: number; name: string } }): Promise<unknown>
  }
  status: {
    findUnique(args: { where: { id: number } }): Promise<unknown>
    create(args: { data: { id: number; name: string } }): Promise<unknown>
  }
  setting: {
    findUnique(args: { where: { key: string } }): Promise<SettingRecord | null>
    create(args: { data: { key: string; value: string; type: string } }): Promise<unknown>
    update(args: {
      where: { key: string }
      data: { value: string; updatedAt: string }
    }): Promise<unknown>
    findMany(args: {}): Promise<SettingRecord[]>
    delete(args: { where: { key: string } }): Promise<unknown>
  }
  agent: CreateModel & {
    count(): Promise<number>
  }
  agentHealth: CreateModel
  agentTag: CreateModel
  vulnerability: CreateModel
  vulnerabilityAgent: CreateModel
  vulnerabilityTimeline: CreateModel
  threatIntelligence: CreateModel
  threatIndicator: CreateModel
  auditLog: CreateModel
  runbookAction: {
    findMany(args: { where?: Record<string, unknown> }): Promise<RunbookActionRecord[]>
    update(args: {
      where: { id: string }
      data: { llmProviderKey: string; llmModel: string; updatedAt: string }
    }): Promise<unknown>
  }
}

export type DesktopDatabaseSeedingOptions = {
  defaultLlmProvider: string
  migrateRemovedCloudLlmSettings?: boolean
  migrateCeKanyeRestRunbook?: boolean
  logger?: {
    info(message: string, ...args: unknown[]): void
    error(message: string, ...args: unknown[]): void
  }
}

const CLI_PROVIDER_KEYS = new Set(['claude_code', 'codex', 'opencode', 'cursor'])
const REMOVED_CLOUD_PROVIDER_KEYS = [
  'groq',
  'kilocode',
  'openai',
  'anthropic',
  'gemini',
  'openrouter',
  'flowise',
]
const KANYE_REST_ACTION_TITLE = 'What did kanye say?'
const KANYE_REST_ACTION_PROMPT = 'Make a philosophical break down of what Kanye said.'
const KANYE_REST_CE_PROVIDER = 'codex'
const KANYE_REST_CE_MODEL = 'gpt-5.4-mini'

async function createSeedRows<T extends SeedRow>(
  rows: T[],
  create: (row: T) => Promise<unknown>,
): Promise<void> {
  for (const row of rows) {
    await create(row)
  }
}

function readSettingString(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim()
}

async function migrateCeKanyeRestRunbook(
  client: DesktopDatabaseSeedClient,
  logger: NonNullable<DesktopDatabaseSeedingOptions['logger']>,
): Promise<void> {
  const actions = await client.runbookAction.findMany({
    where: {
      title: KANYE_REST_ACTION_TITLE,
    },
  })

  let migratedCount = 0

  for (const action of actions) {
    const id = readSettingString(action.id)
    if (id.length === 0) {
      continue
    }

    if (readSettingString(action.prompt) !== KANYE_REST_ACTION_PROMPT) {
      continue
    }

    if (
      readSettingString(action.llmProviderKey) === KANYE_REST_CE_PROVIDER &&
      readSettingString(action.llmModel) === KANYE_REST_CE_MODEL
    ) {
      continue
    }

    await client.runbookAction.update({
      where: { id },
      data: {
        llmProviderKey: KANYE_REST_CE_PROVIDER,
        llmModel: KANYE_REST_CE_MODEL,
        updatedAt: new Date().toISOString(),
      },
    })
    migratedCount += 1
  }

  if (migratedCount > 0) {
    logger.info(
      `[database] Migrated ${String(migratedCount)} Kanye Rest action(s) to ${KANYE_REST_CE_PROVIDER}/${KANYE_REST_CE_MODEL}`,
    )
  }
}

async function migrateRemovedCloudLlmSettings(
  client: DesktopDatabaseSeedClient,
  fallbackProvider: string,
  logger: NonNullable<DesktopDatabaseSeedingOptions['logger']>,
): Promise<void> {
  const primary = await client.setting.findUnique({ where: { key: 'llm.provider' } })
  const previousProvider = readSettingString(primary?.value)

  if (primary !== null && !CLI_PROVIDER_KEYS.has(previousProvider)) {
    await client.setting.update({
      where: { key: 'llm.provider' },
      data: { value: fallbackProvider, updatedAt: new Date().toISOString() },
    })
    logger.info(
      `[database] Migrated llm.provider from removed provider '${previousProvider}' to '${fallbackProvider}'`,
    )
  }

  const removedPrefixes = REMOVED_CLOUD_PROVIDER_KEYS.map((key) => `llm.${key}.`)
  const removedExactKeys = new Set([
    'llm.mcp.baseUrl',
    'llm.mcp.apiKey',
    'mcp.baseUrl',
    'mcp.apiKey',
  ])
  const settings = await client.setting.findMany({})

  for (const setting of settings) {
    const key = readSettingString(setting.key)
    const isRemoved =
      removedExactKeys.has(key) || removedPrefixes.some((prefix) => key.startsWith(prefix))

    if (isRemoved) {
      await client.setting.delete({ where: { key } })
      logger.info(`[database] Removed orphaned cloud LLM setting: ${key}`)
    }
  }
}

export function createDesktopDatabaseSeeders(options: DesktopDatabaseSeedingOptions): {
  seedDefaults(client: DesktopDatabaseSeedClient): Promise<void>
  seedDemoData(client: DesktopDatabaseSeedClient): Promise<void>
} {
  const logger = options.logger ?? console

  async function seedDefaults(client: DesktopDatabaseSeedClient): Promise<void> {
    try {
      const operatorRole = await client.role.findUnique({ where: { id: 1 } })
      if (operatorRole === null) {
        await client.role.create({ data: { id: 1, name: 'operator' } })
        logger.info('[database] Seeded default role: operator')
      }

      const activeStatus = await client.status.findUnique({ where: { id: 1 } })
      if (activeStatus === null) {
        await client.status.create({ data: { id: 1, name: 'active' } })
        logger.info('[database] Seeded default status: active')
      }

      const inactiveStatus = await client.status.findUnique({ where: { id: 2 } })
      if (inactiveStatus === null) {
        await client.status.create({ data: { id: 2, name: 'inactive' } })
        logger.info('[database] Seeded default status: inactive')
      }

      const defaultSettings: Array<{ key: string; value: string; type: string }> = [
        { key: 'llm.provider', value: options.defaultLlmProvider, type: 'string' },
        { key: 'security.passwordMinLength', value: '8', type: 'number' },
        { key: 'security.require2FA', value: 'false', type: 'boolean' },
        { key: 'security.idleAutoLockEnabled', value: 'false', type: 'boolean' },
        { key: 'security.autoLockMinutes', value: '15', type: 'number' },
        { key: 'security.lockOnSleep', value: 'false', type: 'boolean' },
        { key: 'security.rememberMeExpiryHours', value: '720', type: 'number' },
        { key: 'app.setupCompleted', value: 'false', type: 'boolean' },
        { key: 'session.lockState', value: 'unlocked', type: 'string' },
      ]

      for (const setting of defaultSettings) {
        const existing = await client.setting.findUnique({ where: { key: setting.key } })
        if (existing === null) {
          await client.setting.create({ data: setting })
        }
      }

      logger.info('[database] Default seed data ensured')

      if (options.migrateRemovedCloudLlmSettings === true) {
        await migrateRemovedCloudLlmSettings(client, options.defaultLlmProvider, logger)
      }

      if (options.migrateCeKanyeRestRunbook === true) {
        await migrateCeKanyeRestRunbook(client, logger)
      }
    } catch (error) {
      logger.error('[database] Failed to seed defaults:', error)
      throw error
    }
  }

  async function seedDemoData(client: DesktopDatabaseSeedClient): Promise<void> {
    try {
      const agentCount = await client.agent.count()
      if (agentCount > 0) return

      const now = new Date()
      const hourAgo = new Date(now.getTime() - 60 * 60 * 1000)
      const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)

      const agents = [
        {
          id: 'agent-endpoint-01',
          name: 'Workstation Monitor',
          description: 'Endpoint detection and response agent for developer workstations',
          type: 'ENDPOINT',
          status: 'ONLINE',
          version: '2.4.1',
          hostname: 'dev-ws-01.internal',
          ipAddress: '10.0.1.15',
          operatingSystem: 'macOS 14.3',
          capabilities: JSON.stringify(['file_integrity', 'process_monitor', 'network_filter']),
          lastHeartbeat: now,
          lastSeen: now,
          updatedAt: now,
        },
        {
          id: 'agent-network-01',
          name: 'Perimeter Scanner',
          description: 'Network traffic analysis and intrusion detection',
          type: 'NETWORK',
          status: 'ONLINE',
          version: '2.4.0',
          hostname: 'edge-gw-01.dmz',
          ipAddress: '10.0.0.1',
          operatingSystem: 'Ubuntu 22.04',
          capabilities: JSON.stringify(['packet_inspection', 'ids', 'flow_analysis']),
          lastHeartbeat: now,
          lastSeen: now,
          updatedAt: now,
        },
        {
          id: 'agent-cloud-01',
          name: 'Cloud Posture Auditor',
          description: 'AWS cloud security posture management',
          type: 'CLOUD',
          status: 'ONLINE',
          version: '2.3.5',
          hostname: null,
          ipAddress: null,
          operatingSystem: null,
          capabilities: JSON.stringify(['iam_audit', 's3_scan', 'vpc_analysis', 'config_drift']),
          lastHeartbeat: hourAgo,
          lastSeen: hourAgo,
          updatedAt: now,
        },
        {
          id: 'agent-container-01',
          name: 'Container Runtime Guard',
          description: 'Kubernetes container runtime security',
          type: 'CONTAINER',
          status: 'OFFLINE',
          version: '2.2.0',
          hostname: 'k8s-node-03.cluster',
          ipAddress: '10.0.2.30',
          operatingSystem: 'Flatcar Linux',
          capabilities: JSON.stringify(['image_scan', 'runtime_policy', 'network_policy']),
          lastHeartbeat: dayAgo,
          lastSeen: dayAgo,
          updatedAt: now,
        },
        {
          id: 'agent-api-01',
          name: 'API Gateway Sentinel',
          description: 'API security testing and rate-limit enforcement',
          type: 'API',
          status: 'ONLINE',
          version: '2.4.1',
          hostname: 'api-gw-01.internal',
          ipAddress: '10.0.3.10',
          operatingSystem: 'Alpine Linux 3.19',
          capabilities: JSON.stringify(['rate_limiting', 'auth_validation', 'schema_enforcement']),
          lastHeartbeat: now,
          lastSeen: now,
          updatedAt: now,
        },
      ]

      await createSeedRows(agents, (agent) => client.agent.create({ data: agent }))

      const healthRecords = [
        { id: 'health-endpoint-01', agentId: 'agent-endpoint-01', cpuUsage: 23.5, memoryUsage: 45.2, diskUsage: 62.1, networkIn: 1.2, networkOut: 0.8, uptime: 604800, updatedAt: now },
        { id: 'health-network-01', agentId: 'agent-network-01', cpuUsage: 67.8, memoryUsage: 71.3, diskUsage: 38.9, networkIn: 250.5, networkOut: 180.2, uptime: 1209600, updatedAt: now },
        { id: 'health-cloud-01', agentId: 'agent-cloud-01', cpuUsage: 12.1, memoryUsage: 28.7, diskUsage: 15.3, networkIn: 5.4, networkOut: 2.1, uptime: 2592000, updatedAt: now },
        { id: 'health-api-01', agentId: 'agent-api-01', cpuUsage: 41.2, memoryUsage: 55.8, diskUsage: 29.4, networkIn: 85.3, networkOut: 120.7, uptime: 864000, updatedAt: now },
      ]

      await createSeedRows(healthRecords, (health) => client.agentHealth.create({ data: health }))

      const tags = [
        { id: 'tag-01', agentId: 'agent-endpoint-01', key: 'environment', value: 'development' },
        { id: 'tag-02', agentId: 'agent-endpoint-01', key: 'team', value: 'engineering' },
        { id: 'tag-03', agentId: 'agent-network-01', key: 'environment', value: 'production' },
        { id: 'tag-04', agentId: 'agent-cloud-01', key: 'provider', value: 'aws' },
        { id: 'tag-05', agentId: 'agent-container-01', key: 'cluster', value: 'k8s-prod' },
      ]

      await createSeedRows(tags, (tag) => client.agentTag.create({ data: tag }))

      const vulns = [
        { id: 'vuln-01', title: 'Critical RCE in Log4j dependency', description: 'Remote code execution via JNDI injection in log4j-core 2.14.1', severity: 'CRITICAL', status: 'OPEN', cvssScore: 10.0, cveId: 'CVE-2021-44228', source: 'SCA', affectedAsset: 'backend-api', remediation: 'Upgrade log4j-core to 2.17.1+', updatedAt: now },
        { id: 'vuln-02', title: 'SQL Injection in search endpoint', description: 'Unsanitized user input passed to raw SQL query in /api/search', severity: 'HIGH', status: 'IN_PROGRESS', cvssScore: 8.6, cveId: null, source: 'DAST', affectedAsset: 'backend-api', remediation: 'Use parameterized queries', assignedToId: 1, updatedAt: now },
        { id: 'vuln-03', title: 'Outdated TLS 1.0 configuration', description: 'Server accepts deprecated TLS 1.0 connections', severity: 'MEDIUM', status: 'RESOLVED', cvssScore: 5.3, cveId: null, source: 'DAST', affectedAsset: 'edge-gw-01.dmz', remediation: 'Disable TLS 1.0 and 1.1; enforce TLS 1.2+', updatedAt: now },
        { id: 'vuln-04', title: 'Cross-site scripting in user profile', description: 'Stored XSS via firstName field in profile update', severity: 'HIGH', status: 'OPEN', cvssScore: 7.1, cveId: null, source: 'SAST', affectedAsset: 'frontend', remediation: 'Sanitize HTML output with DOMPurify', updatedAt: now },
        { id: 'vuln-05', title: 'Exposed AWS credentials in config', description: 'Hard-coded AWS_SECRET_ACCESS_KEY in docker-compose.yml', severity: 'CRITICAL', status: 'RESOLVED', cvssScore: 9.8, cveId: null, source: 'SAST', affectedAsset: 'infrastructure', remediation: 'Rotate credentials and use secrets manager', updatedAt: now },
        { id: 'vuln-06', title: 'Missing rate limiting on auth endpoint', description: 'No rate limit on /api/auth/login allows brute-force attacks', severity: 'MEDIUM', status: 'OPEN', cvssScore: 5.9, cveId: null, source: 'DAST', affectedAsset: 'backend-api', remediation: 'Add rate limiting middleware (e.g. 5 req/min per IP)', updatedAt: now },
        { id: 'vuln-07', title: 'Prototype pollution in lodash', description: 'lodash < 4.17.21 allows prototype pollution via merge functions', severity: 'LOW', status: 'FALSE_POSITIVE', cvssScore: 3.7, cveId: 'CVE-2021-23337', source: 'SCA', affectedAsset: 'frontend', remediation: 'Upgrade lodash to 4.17.21+', falsePositiveJustification: 'Function not reachable from user input paths', updatedAt: now },
        { id: 'vuln-08', title: 'Container running as root', description: 'Production container image runs processes as root user', severity: 'HIGH', status: 'IN_PROGRESS', cvssScore: 7.8, cveId: null, source: 'SAST', affectedAsset: 'k8s-prod', remediation: 'Add USER directive to Dockerfile; update securityContext in pod spec', assignedToId: 1, updatedAt: now },
      ]

      await createSeedRows(vulns, (vuln) => client.vulnerability.create({ data: vuln }))

      const vulnAgents = [
        { id: 'va-01', vulnerabilityId: 'vuln-01', agentId: 'agent-endpoint-01' },
        { id: 'va-02', vulnerabilityId: 'vuln-02', agentId: 'agent-api-01' },
        { id: 'va-03', vulnerabilityId: 'vuln-03', agentId: 'agent-network-01' },
        { id: 'va-04', vulnerabilityId: 'vuln-04', agentId: 'agent-endpoint-01' },
        { id: 'va-05', vulnerabilityId: 'vuln-06', agentId: 'agent-api-01' },
        { id: 'va-06', vulnerabilityId: 'vuln-08', agentId: 'agent-container-01' },
      ]

      await createSeedRows(vulnAgents, (va) => client.vulnerabilityAgent.create({ data: va }))

      const timelineEntries = [
        { id: 'vt-01', vulnerabilityId: 'vuln-01', action: 'created', newStatus: 'OPEN', createdAt: dayAgo },
        { id: 'vt-02', vulnerabilityId: 'vuln-02', action: 'created', newStatus: 'OPEN', createdAt: dayAgo },
        { id: 'vt-03', vulnerabilityId: 'vuln-02', action: 'status_changed', oldStatus: 'OPEN', newStatus: 'IN_PROGRESS', comment: 'Assigned to development team', userId: 1, createdAt: hourAgo },
        { id: 'vt-04', vulnerabilityId: 'vuln-03', action: 'status_changed', oldStatus: 'OPEN', newStatus: 'RESOLVED', comment: 'TLS configuration updated', userId: 1, createdAt: hourAgo },
        { id: 'vt-05', vulnerabilityId: 'vuln-05', action: 'status_changed', oldStatus: 'OPEN', newStatus: 'RESOLVED', comment: 'Credentials rotated and moved to AWS Secrets Manager', userId: 1, createdAt: hourAgo },
      ]

      await createSeedRows(
        timelineEntries,
        (entry) => client.vulnerabilityTimeline.create({ data: entry }),
      )

      const threats = [
        { id: 'threat-01', source: 'CISA Advisory', type: 'MALWARE', severity: 'CRITICAL', title: 'BlackCat Ransomware Campaign', description: 'Active ransomware campaign targeting healthcare and critical infrastructure using ALPHV/BlackCat variant', mitre: JSON.stringify({ tactics: ['TA0001', 'TA0040'], techniques: ['T1566.001', 'T1486'] }), confidence: 95, active: true, updatedAt: now },
        { id: 'threat-02', source: 'Internal SOC', type: 'PHISHING', severity: 'HIGH', title: 'Spear-phishing campaign targeting engineering team', description: 'Targeted phishing emails impersonating CI/CD service notifications with credential harvesting links', confidence: 88, active: true, updatedAt: now },
        { id: 'threat-03', source: 'NVD', type: 'VULNERABILITY', severity: 'HIGH', title: 'Zero-day in OpenSSH server', description: 'Pre-authentication remote code execution in OpenSSH 9.1-9.3 via crafted SSH packets', mitre: JSON.stringify({ tactics: ['TA0001'], techniques: ['T1190'] }), confidence: 92, active: true, updatedAt: now },
        { id: 'threat-04', source: 'Threat Feed', type: 'EXPLOIT', severity: 'CRITICAL', title: 'Active exploitation of Confluence RCE', description: 'Threat actors actively exploiting CVE-2023-22527 in unpatched Confluence instances', mitre: JSON.stringify({ tactics: ['TA0001', 'TA0002'], techniques: ['T1190', 'T1059'] }), confidence: 97, active: true, updatedAt: now },
        { id: 'threat-05', source: 'Partner ISAC', type: 'MALWARE', severity: 'MEDIUM', title: 'New Infostealer variant targeting browser credentials', description: 'Lumma Stealer variant distributed via fake software update sites', confidence: 75, active: true, updatedAt: now },
        { id: 'threat-06', source: 'CISA Advisory', type: 'VULNERABILITY', severity: 'LOW', title: 'Deprecated cipher suites in legacy services', description: 'Several legacy internal services still using DES/3DES cipher suites', confidence: 60, active: false, expiresAt: dayAgo, updatedAt: now },
      ]

      await createSeedRows(
        threats,
        (threat) => client.threatIntelligence.create({ data: threat }),
      )

      const indicators = [
        { id: 'ind-01', threatId: 'threat-01', type: 'HASH', value: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', description: 'BlackCat ransomware payload SHA-256' },
        { id: 'ind-02', threatId: 'threat-01', type: 'IP', value: '198.51.100.23', description: 'C2 server IP' },
        { id: 'ind-03', threatId: 'threat-02', type: 'DOMAIN', value: 'ci-cd-notifications.example-phish.com', description: 'Phishing domain' },
        { id: 'ind-04', threatId: 'threat-02', type: 'EMAIL', value: 'no-reply@ci-cd-notifications.example-phish.com', description: 'Sender address' },
        { id: 'ind-05', threatId: 'threat-03', type: 'CVE', value: 'CVE-2024-6387', description: 'OpenSSH vulnerability identifier' },
        { id: 'ind-06', threatId: 'threat-04', type: 'CVE', value: 'CVE-2023-22527', description: 'Confluence RCE vulnerability' },
        { id: 'ind-07', threatId: 'threat-04', type: 'IP', value: '203.0.113.42', description: 'Known exploitation source IP' },
        { id: 'ind-08', threatId: 'threat-05', type: 'URL', value: 'https://software-update-center.example.com/download', description: 'Malware distribution URL' },
        { id: 'ind-09', threatId: 'threat-05', type: 'HASH', value: 'f0e1d2c3b4a5f0e1d2c3b4a5f0e1d2c3b4a5f0e1d2c3b4a5f0e1d2c3b4a5f0e1', description: 'Lumma Stealer dropper hash' },
      ]

      await createSeedRows(
        indicators,
        (indicator) => client.threatIndicator.create({ data: indicator }),
      )

      const auditEntries = [
        { action: 'agent.heartbeat', userId: null, details: JSON.stringify({ agentId: 'agent-endpoint-01', agentName: 'Workstation Monitor' }), createdAt: now },
        { action: 'vulnerability.created', userId: null, details: JSON.stringify({ vulnerabilityId: 'vuln-01', title: 'Critical RCE in Log4j dependency', severity: 'CRITICAL' }), createdAt: dayAgo },
        { action: 'vulnerability.status_changed', userId: 1, details: JSON.stringify({ vulnerabilityId: 'vuln-02', from: 'OPEN', to: 'IN_PROGRESS' }), createdAt: hourAgo },
        { action: 'threat.created', userId: null, details: JSON.stringify({ threatId: 'threat-01', title: 'BlackCat Ransomware Campaign' }), createdAt: dayAgo },
        { action: 'agent.created', userId: 1, details: JSON.stringify({ agentId: 'agent-endpoint-01', agentName: 'Workstation Monitor' }), createdAt: dayAgo },
      ]

      await createSeedRows(auditEntries, (entry) => client.auditLog.create({ data: entry }))

      logger.info('[database] Demo data seeded (agents, vulnerabilities, threats)')
    } catch (error) {
      logger.error('[database] Failed to seed demo data:', error)
    }
  }

  return {
    seedDefaults,
    seedDemoData,
  }
}
