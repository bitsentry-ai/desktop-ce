import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildPluginInputSchema } from '../src/features/plugins/desktop-plugin-registry'
import type { DesktopPluginFieldDefinition } from '../src/features/plugins'

function stringField(
  overrides: Partial<DesktopPluginFieldDefinition> = {},
): DesktopPluginFieldDefinition {
  return {
    key: 'scope',
    label: 'Scope',
    type: 'string',
    required: true,
    ...overrides,
  }
}

describe('buildPluginInputSchema', () => {
  it('publishes enumValues and keeps fields without them unchanged', () => {
    const schema = z.toJSONSchema(buildPluginInputSchema([
      stringField({ enumValues: ['read', 'write', 'admin'] }),
      stringField({ key: 'name', label: 'Name' }),
    ])) as {
      properties: Record<string, Record<string, unknown>>;
    }

    expect(schema.properties.scope).toEqual({
      type: 'string',
      enum: ['read', 'write', 'admin'],
    })
    expect(schema.properties.name).toEqual({ type: 'string' })
  })

  it('rejects out-of-enum values with the existing error message', () => {
    const schema = buildPluginInputSchema([
      stringField({ enumValues: ['read', 'write', 'admin'] }),
    ])
    const result = schema.safeParse({ scope: 'delete' })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(
        'Scope must be one of: read, write, admin.',
      )
    }
  })

  it('preserves the default while publishing enumValues', () => {
    const schema = buildPluginInputSchema([
      stringField({
        required: false,
        defaultValue: 'read',
        enumValues: ['read', 'write', 'admin'],
      }),
    ])
    const jsonSchema = z.toJSONSchema(schema) as {
      properties: { scope: Record<string, unknown> };
    }

    expect(jsonSchema.properties.scope).toEqual({
      default: 'read',
      type: 'string',
      enum: ['read', 'write', 'admin'],
    })
    expect(schema.parse({})).toEqual({ scope: 'read' })
  })
})
