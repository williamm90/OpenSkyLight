import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { ContactDto } from '@shared/types'
import { buildCallLink, formatPhone } from '@shared/callLink'
import { useContacts, useSettings } from '../../api/hooks'
import { Avatar } from '../../components/Avatar'
import { isWebMode } from '../../api/webBridge'
import { useToasts } from '../../stores/toastStore'

function PhoneIcon({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M6.6 10.8a15.2 15.2 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1l-2.3 2.2Z" />
    </svg>
  )
}

/** Big "Call Grandma?" sheet: one more tap so a stray touch never dials. */
export function CallConfirm({ contact, onClose }: { contact: ContactDto | null; onClose: () => void }) {
  const { data: settings } = useSettings()
  const pushToast = useToasts((s) => s.push)
  if (!contact) return null
  const method = settings?.calling.method ?? 'googleVoice'

  const call = (): void => {
    const link = buildCallLink(contact.phone, method)
    onClose()
    if (isWebMode()) {
      // the tablet's browser hands tel:/intent: links to Android (→ Google Voice)
      window.location.href = link
    } else {
      // desktop app: the OS decides (e.g. Phone Link on Windows)
      window.open(`tel:${contact.phone}`)
      pushToast(`Calling ${contact.name}…`)
    }
  }

  // portal: tiles live in transformed grid cells, which would trap a fixed overlay
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div className="animate-fade-in absolute inset-0 bg-ink/45 backdrop-blur-[3px]" onClick={onClose} />
      <div className="animate-pop relative flex w-full max-w-sm flex-col items-center gap-5 rounded-[2rem] bg-card p-8 shadow-float">
        <Avatar name={contact.name} color={contact.color} photo={contact.photo} size={168} />
        <div className="text-center">
          <div className="font-display text-4xl font-semibold">Call {contact.name}?</div>
          <div className="mt-1 text-lg font-bold text-ink-faint">{formatPhone(contact.phone)}</div>
        </div>
        <div className="flex w-full gap-3">
          <button
            type="button"
            onClick={onClose}
            className="pressable min-h-16 flex-1 rounded-2xl bg-paper-deep text-xl font-bold text-ink"
          >
            Not now
          </button>
          <button
            type="button"
            onClick={call}
            className="pressable flex min-h-16 flex-[1.4] items-center justify-center gap-2 rounded-2xl bg-[#2f9e55] text-xl font-extrabold text-white shadow-card"
          >
            <PhoneIcon /> Call
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/** Grid of big photo buttons. Used by the home tile and the full-screen sheet. */
export function CallGrid({ compact = false }: { compact?: boolean }) {
  const { data: contacts = [], isLoading } = useContacts()
  const [calling, setCalling] = useState<ContactDto | null>(null)

  if (isLoading) return null
  if (contacts.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-2 text-center text-sm font-bold text-ink-faint">
        Parents can add people to call in Settings → Family
      </div>
    )
  }
  const size = compact ? 64 : 92
  return (
    <>
      <div className="flex h-full flex-wrap content-center items-center justify-center gap-x-4 gap-y-3 overflow-hidden">
        {contacts.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setCalling(c)
            }}
            className="pressable flex flex-col items-center gap-1.5 rounded-2xl p-1"
          >
            <span className="relative">
              <Avatar name={c.name} color={c.color} photo={c.photo} size={size} />
              <span className="absolute -right-1 -bottom-1 flex h-8 w-8 items-center justify-center rounded-full bg-[#2f9e55] text-white shadow-card">
                <PhoneIcon size={17} />
              </span>
            </span>
            <span className={`max-w-[7rem] truncate font-bold ${compact ? 'text-sm' : 'text-base'}`}>{c.name}</span>
          </button>
        ))}
      </div>
      <CallConfirm contact={calling} onClose={() => setCalling(null)} />
    </>
  )
}
