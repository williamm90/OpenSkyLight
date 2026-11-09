export const GOOGLE_VOICE_PACKAGE = 'com.google.android.apps.googlevoice'

/**
 * Build the link a call button opens.
 *
 * Google Voice has no public calling API, so the display hands the number to
 * the Google Voice app on the tablet:
 *  - 'googleVoice': an Android intent link that targets the Voice app
 *    directly (falls back to a plain tel: link if Voice isn't installed)
 *  - 'tel': a plain tel: link; Android asks which app to use the first time
 *    ("Always" → Google Voice)
 */
export function buildCallLink(phone: string, method: 'tel' | 'googleVoice'): string {
  const number = phone.replace(/[^\d+]/g, '')
  const tel = `tel:${number}`
  if (method === 'tel') return tel
  return (
    `intent:${number}#Intent;scheme=tel;action=android.intent.action.DIAL;` +
    `package=${GOOGLE_VOICE_PACKAGE};S.browser_fallback_url=${encodeURIComponent(tel)};end`
  )
}

/** "+15551234567" → "(555) 123-4567" for North American numbers; else as stored. */
export function formatPhone(phone: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone)
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : phone
}
