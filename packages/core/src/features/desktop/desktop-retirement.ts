import BetterSqlite3 from 'better-sqlite3'

export const RETIRED_DESKTOP_TABLES = ['Role', 'Status', 'User', 'Session', 'Agent', 'AgentHealth', 'AgentTag', 'Vulnerability', 'VulnerabilityAgent', 'VulnerabilityTimeline', 'ThreatIntelligence', 'ThreatIndicator', 'Integration', 'IntegrationHealth', 'Ticket', 'Report', 'Scan', 'CveEntry', 'TelemetryCveLink', 'DiagnosisSession', 'DiagnosisTraceEntry', 'DiagnosisToolRun', 'DiagnosisReport', 'ActivityEvent'] as const
const quote = (value: string): string => '"' + value.replaceAll('"', '""') + '"'
type Cell = { type: 'integer' | 'blob' | 'value'; value: string | number | null }
type ArchivedTable = { name: string; sql: string; columns: string[]; rows: Cell[][] }
function encode(value: unknown): Cell {
  if (typeof value === 'bigint') return { type: 'integer', value: value.toString() }
  if (Buffer.isBuffer(value)) return { type: 'blob', value: value.toString('base64') }
  if (value === null || typeof value === 'number' || typeof value === 'string') return { type: 'value', value }
  throw new Error('Unsupported SQLite archive value')
}
function decode(cell: Cell): unknown {
  if (cell.type === 'integer') return BigInt(String(cell.value))
  if (cell.type === 'blob') return Buffer.from(String(cell.value), 'base64')
  return cell.value
}
function rows(database: BetterSqlite3.Database, table: string): Cell[][] {
  return (database.prepare(`SELECT * FROM ${quote(table)}`).safeIntegers(true).raw(true).all() as unknown[][]).map(row => row.map(encode)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}
export function verifyDesktopRetirementArchive(payload: string): void {
  const archive = JSON.parse(payload) as { version: number; tables: ArchivedTable[] }
  if (archive.version !== 1) throw new Error('Unsupported retirement archive')
  const restored = new BetterSqlite3(':memory:')
  try {
    restored.pragma('foreign_keys = OFF')
    for (const table of archive.tables) restored.exec(table.sql)
    for (const table of archive.tables) {
      // eslint-disable-next-line sonarjs/sql-queries -- Identifiers are quoted; archived cell values are bound parameters.
      const insert = restored.prepare(`INSERT INTO ${quote(table.name)} (${table.columns.map(quote).join(',')}) VALUES (${table.columns.map(() => '?').join(',')})`)
      for (const row of table.rows) insert.run(...row.map(decode))
      if (JSON.stringify(rows(restored, table.name)) !== JSON.stringify(table.rows)) throw new Error('Retirement archive restore mismatch')
    }
    if (restored.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Retirement archive integrity check failed')
  } finally { restored.close() }
}
export async function retireDesktopTables(database: BetterSqlite3.Database, archiveAndVerify: (payload: string) => Promise<void>): Promise<void> {
  const foreignKeys = database.pragma('foreign_keys', { simple: true })
  database.pragma('foreign_keys = OFF')
  try {
    database.exec('BEGIN IMMEDIATE')
    const all = database.prepare("SELECT name,sql FROM sqlite_master WHERE type='table'").all() as Array<{ name: string; sql: string }>
    const retired = new Set<string>(RETIRED_DESKTOP_TABLES)
    const selected = all.filter(table => retired.has(table.name))
    for (const table of all.filter(table => !retired.has(table.name))) {
      const references = database.prepare(`PRAGMA foreign_key_list(${quote(table.name)})`).all() as Array<{ table: string }>
      if (references.some(reference => retired.has(reference.table))) throw new Error('An active table still references retired Desktop data')
    }
    const tables = selected.map(table => ({ ...table, columns: (database.prepare(`PRAGMA table_info(${quote(table.name)})`).all() as Array<{ name: string }>).map(column => column.name), rows: rows(database, table.name) }))
    if (tables.some(table => table.rows.length > 0)) {
      const extras = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL").all() as Array<{ tbl_name: string }>
      const payload = JSON.stringify({ version: 1, tables, extras: extras.filter(item => retired.has(item.tbl_name)) })
      verifyDesktopRetirementArchive(payload)
      await archiveAndVerify(payload)
    }
    for (const table of selected) database.exec(`DROP TABLE ${quote(table.name)}`)
    if ((database.pragma('foreign_key_check') as unknown[]).length > 0) throw new Error('Retirement would leave invalid active references')
    database.exec('COMMIT')
  } catch (error) {
    if (database.inTransaction) { database.exec('ROLLBACK') }
    throw error
  }
  finally { database.pragma(`foreign_keys = ${foreignKeys === 1 ? 'ON' : 'OFF'}`) }
}
