import { useState } from 'react'
import { pairWithCode } from '../../api/webBridge'

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del']

/** First-run screen on a browser display: enter the 6-digit code from the home server. */
export function PairScreen({ offline }: { offline: boolean }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(offline ? "Can't reach the home server. Is it running?" : null)
  const [busy, setBusy] = useState(false)

  const press = async (key: string): Promise<void> => {
    if (busy || !key) return
    if (key === 'del') {
      setCode((c) => c.slice(0, -1))
      return
    }
    const next = (code + key).slice(0, 6)
    setCode(next)
    setError(null)
    if (next.length < 6) return
    setBusy(true)
    const err = await pairWithCode(next)
    setBusy(false)
    if (err) {
      setError(err)
      setCode('')
    } else {
      window.location.reload()
    }
  }

  return (
    <div className="flex h-full w-full items-center justify-center bg-paper text-ink">
      <div className="flex w-[24rem] flex-col items-center gap-6">
        <h1 className="font-display text-4xl font-semibold">Connect this screen</h1>
        <p className="text-center text-lg text-ink-soft">
          Enter the 6-digit code from your OpenSkyLight home server. It's printed in the server's log, or a
          parent can make one in Settings → General on a screen that's already connected.
        </p>
        <div className="flex gap-2">
          {Array.from({ length: 6 }, (_, i) => (
            <div
              key={i}
              className="flex h-14 w-11 items-center justify-center rounded-xl border-2 border-line bg-card font-display text-3xl font-semibold"
            >
              {code[i] ?? ''}
            </div>
          ))}
        </div>
        <div className="min-h-6 text-center font-bold text-[#E5484D]">{error}</div>
        <div className="grid grid-cols-3 gap-3">
          {KEYS.map((k, i) => (
            <button
              key={i}
              type="button"
              disabled={!k || busy}
              onClick={() => void press(k)}
              className="pressable h-16 w-20 rounded-2xl bg-card text-2xl font-bold shadow-sm disabled:opacity-0"
            >
              {k === 'del' ? '⌫' : k}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
