import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { retireDesktopTables, verifyDesktopRetirementArchive } from '../src/features/desktop/desktop-retirement'

describe('Desktop physical retirement', () => {
  it('verifies a restorable archive before removing legacy tables and keeps active data', async () => {
    const db = new Database(':memory:')
    try {
      db.exec('CREATE TABLE User (id INTEGER PRIMARY KEY, secret BLOB); CREATE TABLE Runbook (id TEXT PRIMARY KEY); INSERT INTO Runbook VALUES (\'keep\')')
      db.prepare('INSERT INTO User VALUES (?,?)').run(9223372036854775807n, Buffer.from('private'))
      let saved = ''
      await retireDesktopTables(db, async payload => { saved = payload; verifyDesktopRetirementArchive(payload) })
      expect(saved).toContain('9223372036854775807')
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='User'").get()).toBeUndefined()
      expect(db.prepare('SELECT id FROM Runbook').get()).toEqual({ id: 'keep' })
      await retireDesktopTables(db, async () => { throw new Error('No second archive needed') })
    } finally { db.close() }
  })
  it('rolls back when encryption or durable verification fails', async () => {
    const db = new Database(':memory:')
    try {
      db.pragma('foreign_keys = ON')
      db.exec("CREATE TABLE Agent (id TEXT); INSERT INTO Agent VALUES ('preserve')")
      await expect(retireDesktopTables(db, async () => { throw new Error('key unavailable') })).rejects.toThrow('key unavailable')
      expect(db.prepare('SELECT id FROM Agent').get()).toEqual({ id: 'preserve' })
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    } finally { db.close() }
  })
  it('refuses an active foreign key into retired storage', async () => {
    const db = new Database(':memory:')
    try {
      db.exec('CREATE TABLE User(id INTEGER PRIMARY KEY); CREATE TABLE ActiveRecord(id INTEGER REFERENCES User(id))')
      await expect(retireDesktopTables(db, async () => {})).rejects.toThrow('active table')
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='User'").get()).toBeDefined()
    } finally { db.close() }
  })
})
