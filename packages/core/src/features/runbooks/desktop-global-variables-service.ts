import {
  globalVariableInputSchema,
  globalVariablePatchSchema,
  type GlobalVariable,
  type GlobalVariableInput,
  type GlobalVariablePatch,
} from './globals.schemas'

const DESKTOP_SCOPE = {
  product: 'bitsentry-desktop',
  owner: 'local_app',
} as const

type GlobalVariableRow = Record<string, unknown>
type ResolvedGlobalDefinition = {
  key: string
  secure?: boolean
  description?: string
}
type ResolvedGlobalsAccumulator = {
  values: Record<string, string>
  definitions: ResolvedGlobalDefinition[]
  secureKeys: Set<string>
}

export interface DesktopGlobalVariablesDb {
  globalVariable: {
    findMany(args: { orderBy: { key: 'asc' } }): Promise<GlobalVariableRow[]>
    findUnique(args: {
      where: { id?: string; key?: string }
    }): Promise<GlobalVariableRow | null>
    create(args: {
      data: {
        id: string
        key: string
        value: string | null
        description: string | null
        secure: boolean
        createdAt: string
        updatedAt: string
      }
    }): Promise<GlobalVariableRow>
    update(args: {
      where: { id: string }
      data: {
        key: string
        value: string | null
        description: string | null
        secure: boolean
        updatedAt: string
      }
    }): Promise<GlobalVariableRow>
    delete(args: { where: { id: string } }): Promise<unknown>
  }
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  if (trimmed.length > 0) {
    return trimmed
  }

  return undefined
}

function asIsoString(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString()
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString()
    }
  }

  return new Date().toISOString()
}

function normalizeGlobalVariablePatch(
  patch: GlobalVariablePatch,
): GlobalVariablePatch {
  const normalizedPatch = { ...patch }
  if (patch.key !== undefined) {
    normalizedPatch.key = patch.key.trim()
  }
  if (patch.description !== undefined) {
    normalizedPatch.description = normalizeString(patch.description)
  }

  return globalVariablePatchSchema.parse(normalizedPatch)
}

function resolveNextSecure(
  parsed: GlobalVariablePatch,
  current: GlobalVariable,
): boolean {
  if (parsed.secure !== undefined) {
    return parsed.secure
  }

  return current.secure === true
}

function resolveNextValue(
  parsed: GlobalVariablePatch,
  current: GlobalVariable,
): string | undefined {
  if (Object.prototype.hasOwnProperty.call(parsed, 'value')) {
    return parsed.value
  }

  return current.value
}

function resolveNextDescription(
  parsed: GlobalVariablePatch,
  current: GlobalVariable,
): string | null {
  if (parsed.description !== undefined) {
    return parsed.description ?? null
  }

  return current.description ?? null
}

function rowString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value
  }

  return undefined
}

function toResolvedGlobalDefinition(
  key: string,
  row: GlobalVariableRow,
  secure: boolean,
): ResolvedGlobalDefinition {
  const definition: ResolvedGlobalDefinition = { key }
  if (secure) {
    definition.secure = true
  }
  const description = rowString(row.description)
  if (description !== undefined) {
    definition.description = description
  }

  return definition
}

function addResolvedGlobalRow(
  accumulator: ResolvedGlobalsAccumulator,
  row: GlobalVariableRow,
): void {
  const key = String(row.key)
  const secure = row.secure === true
  const value = rowString(row.value)
  accumulator.definitions.push(toResolvedGlobalDefinition(key, row, secure))

  if (secure) {
    accumulator.secureKeys.add(key)
  }

  if (value !== undefined) {
    accumulator.values[key] = value
  }
}

function generateUuid(): string {
  return globalThis.crypto.randomUUID()
}

export class DesktopGlobalVariablesService {
  constructor(protected readonly db: DesktopGlobalVariablesDb) {}

  async list(): Promise<GlobalVariable[]> {
    const rows = await this.db.globalVariable.findMany({
      orderBy: { key: 'asc' },
    })
    return rows.map((row) => this.toGlobalVariable(row))
  }

  async getByKey(key: string): Promise<GlobalVariable | null> {
    const normalizedKey = key.trim()
    if (normalizedKey.length === 0) {
      return null
    }

    const row = await this.db.globalVariable.findUnique({
      where: { key: normalizedKey },
    })
    if (row === null) {
      return null
    }

    return this.toGlobalVariable(row)
  }

  async create(input: GlobalVariableInput): Promise<GlobalVariable> {
    const parsed = globalVariableInputSchema.parse({
      ...input,
      key: input.key.trim(),
      description: normalizeString(input.description),
    })

    const existing = await this.db.globalVariable.findUnique({
      where: { key: parsed.key },
    })
    if (existing !== null) {
      throw new Error(`Global variable "${parsed.key}" already exists`)
    }

    const secure = parsed.secure === true
    const now = new Date().toISOString()
    let rawValue: string | undefined
    if (typeof parsed.value === 'string') {
      rawValue = parsed.value
    }
    const created = await this.db.globalVariable.create({
      data: {
        id: generateUuid(),
        key: parsed.key,
        value: rawValue ?? null,
        description: parsed.description ?? null,
        secure,
        createdAt: now,
        updatedAt: now,
      },
    })

    return this.toGlobalVariable(created)
  }

  async update(
    id: string,
    patch: GlobalVariablePatch,
  ): Promise<GlobalVariable | null> {
    const existing = await this.db.globalVariable.findUnique({
      where: { id },
    })
    if (existing === null) {
      return null
    }

    const parsed = normalizeGlobalVariablePatch(patch)
    const current = this.toGlobalVariable(existing)
    const nextKey = parsed.key ?? current.key
    await this.assertUniqueKey(id, nextKey, current.key)

    const updated = await this.db.globalVariable.update({
      where: { id },
      data: {
        key: nextKey,
        value: resolveNextValue(parsed, current) ?? null,
        description: resolveNextDescription(parsed, current),
        secure: resolveNextSecure(parsed, current),
        updatedAt: new Date().toISOString(),
      },
    })

    return this.toGlobalVariable(updated)
  }

  async delete(id: string): Promise<{ deleted: boolean }> {
    const existing = await this.db.globalVariable.findUnique({
      where: { id },
    })

    if (existing === null) {
      return { deleted: false }
    }

    await this.db.globalVariable.delete({ where: { id } })
    return { deleted: true }
  }

  async loadResolvedGlobals(): Promise<{
    values: Record<string, string>
    definitions: Array<{ key: string; secure?: boolean; description?: string }>
    secureKeys: Set<string>
  }> {
    const rows = await this.db.globalVariable.findMany({
      orderBy: { key: 'asc' },
    })
    const accumulator: ResolvedGlobalsAccumulator = {
      values: {},
      definitions: [],
      secureKeys: new Set<string>(),
    }

    for (const row of rows) {
      addResolvedGlobalRow(accumulator, row)
    }

    return accumulator
  }

  protected async assertUniqueKey(
    id: string,
    nextKey: string,
    currentKey: string,
  ): Promise<void> {
    if (nextKey === currentKey) {
      return
    }

    const duplicate = await this.db.globalVariable.findUnique({
      where: { key: nextKey },
    })
    if (duplicate !== null && String(duplicate.id) !== id) {
      throw new Error(`Global variable "${nextKey}" already exists`)
    }
  }

  protected toGlobalVariable(row: GlobalVariableRow): GlobalVariable {
    const secure = row.secure === true
    let storedValue: string | undefined
    if (typeof row.value === 'string') {
      storedValue = row.value
    }

    const variable: GlobalVariable = {
      id: String(row.id),
      key: String(row.key),
      scope: DESKTOP_SCOPE,
      createdAt: asIsoString(row.createdAt),
      updatedAt: asIsoString(row.updatedAt),
    }
    if (!secure && storedValue !== undefined) {
      variable.value = storedValue
    }
    if (typeof row.description === 'string') {
      variable.description = row.description
    }
    if (secure) {
      variable.secure = true
    }

    return variable
  }
}
