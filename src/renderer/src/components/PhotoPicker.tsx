import { useRef, useState } from 'react'
import { Avatar } from './Avatar'
import { fileToAvatar } from '../lib/photo'

/**
 * Tap the circle to choose a photo. On a tablet this opens the gallery or
 * camera; the image is cropped square and shrunk before it's saved.
 */
export function PhotoPicker({
  name,
  color,
  photo,
  onChange
}: {
  name: string
  color: string
  photo: string | null
  onChange: (photo: string | null) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      onChange(await fileToAvatar(file))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t read that photo')
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className="flex items-center gap-4">
      <button type="button" onClick={() => inputRef.current?.click()} className="pressable rounded-full" aria-label="Choose photo">
        <Avatar name={name || '?'} color={color} photo={photo} size={88} />
      </button>
      <div className="flex flex-col items-start gap-2">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="pressable rounded-full border-2 border-line bg-card px-4 py-1.5 text-sm font-bold text-ink-soft"
        >
          {busy ? 'Loading…' : photo ? 'Change photo' : 'Add photo'}
        </button>
        {photo && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="pressable px-1 text-sm font-bold text-ember-deep"
          >
            Remove photo
          </button>
        )}
        {error && <span className="text-sm font-bold text-ember-deep">{error}</span>}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
    </div>
  )
}
