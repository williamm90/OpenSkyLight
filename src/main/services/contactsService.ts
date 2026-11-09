import { and, asc, eq, isNull, max } from 'drizzle-orm'
import { DateTime } from 'luxon'
import type { AppDb } from '../db/client'
import { contacts } from '../db/schema'
import { uuidv7 } from '@shared/uuid'
import { isoUtc } from '@shared/dates'
import type { ContactCreateInput, ContactDto, ContactUpdateInput } from '@shared/types'
import { invalid, notFound } from './errors'

/** Strip formatting so the dialer gets "+15551234567"; keeps a leading +. */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim()
  const digits = trimmed.replace(/\D/g, '')
  if (digits.length < 3) throw invalid('That phone number is too short')
  if (digits.length > 15) throw invalid('That phone number is too long')
  if (trimmed.startsWith('+')) return `+${digits}`
  // assume North America for bare 10-digit numbers — Google Voice's home turf
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return digits
}

function toDto(row: typeof contacts.$inferSelect): ContactDto {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    photo: row.photo ?? null,
    color: row.color,
    sortOrder: row.sortOrder
  }
}

/** One-tap call contacts. Parents manage them behind the PIN; kids only see them. */
export function createContactsService(db: AppDb) {
  function list(): ContactDto[] {
    return db
      .select()
      .from(contacts)
      .where(isNull(contacts.deletedAt))
      .orderBy(asc(contacts.sortOrder), asc(contacts.createdAt))
      .all()
      .map(toDto)
  }

  function create(input: ContactCreateInput): ContactDto {
    const [{ value: maxSort }] = db.select({ value: max(contacts.sortOrder) }).from(contacts).all()
    const id = uuidv7()
    db.insert(contacts)
      .values({
        id,
        name: input.name,
        phone: normalizePhone(input.phone),
        photo: input.photo ?? null,
        color: input.color,
        sortOrder: (maxSort ?? 0) + 1,
        createdAt: isoUtc(DateTime.utc())
      })
      .run()
    const [row] = db.select().from(contacts).where(eq(contacts.id, id)).all()
    return toDto(row)
  }

  function update(input: ContactUpdateInput): ContactDto {
    const patch: Partial<typeof contacts.$inferInsert> = {}
    if (input.name !== undefined) patch.name = input.name
    if (input.phone !== undefined) patch.phone = normalizePhone(input.phone)
    if (input.photo !== undefined) patch.photo = input.photo
    if (input.color !== undefined) patch.color = input.color
    if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder
    const result = db
      .update(contacts)
      .set(patch)
      .where(and(eq(contacts.id, input.id), isNull(contacts.deletedAt)))
      .run()
    if (result.changes === 0) throw notFound('Contact')
    const [row] = db.select().from(contacts).where(eq(contacts.id, input.id)).all()
    return toDto(row)
  }

  function remove(id: string): void {
    const result = db
      .update(contacts)
      .set({ deletedAt: isoUtc(DateTime.utc()) })
      .where(and(eq(contacts.id, id), isNull(contacts.deletedAt)))
      .run()
    if (result.changes === 0) throw notFound('Contact')
  }

  return { list, create, update, remove }
}

export type ContactsService = ReturnType<typeof createContactsService>
