import { useEffect, useId, useRef, useState } from 'react'
import { create } from 'zustand'
import Keyboard from 'react-simple-keyboard'
import 'react-simple-keyboard/build/css/index.css'
import { useSettings } from '../api/hooks'
import { isWebMode } from '../api/webBridge'

interface OskTarget {
  id: string
  get: () => string
  set: (value: string) => void
}

interface OskState {
  target: OskTarget | null
  /** bumped when the focused input's value changes from physical typing */
  echo: number
  open(target: OskTarget): void
  close(): void
  /** close only if `id` is still the active target (used by input blur) */
  closeIf(id: string): void
  bump(): void
}

export const useOsk = create<OskState>((set) => ({
  target: null,
  echo: 0,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
  closeIf: (id) => set((s) => (s.target?.id === id ? { target: null } : {})),
  bump: () => set((s) => ({ echo: s.echo + 1 }))
}))

/** 'auto' = built-in keyboard in the desktop app, the device's own keyboard in a browser. */
function useBuiltInKeyboard(): boolean {
  const { data: settings } = useSettings()
  const mode = settings?.onScreenKeyboard ?? 'auto'
  return mode === 'on' || (mode === 'auto' && !isWebMode())
}

export function OskInput({
  value,
  onChange,
  placeholder,
  autoFocus,
  className = ''
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  autoFocus?: boolean
  className?: string
}) {
  const id = useId()
  const valRef = useRef(value)
  const cbRef = useRef(onChange)
  valRef.current = value
  cbRef.current = onChange
  const { open, bump, target } = useOsk()
  const builtIn = useBuiltInKeyboard()

  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      // with the built-in keyboard up, keep a tablet's own keyboard from also popping up
      inputMode={builtIn ? 'none' : undefined}
      onFocus={(e) => {
        if (builtIn) open({ id, get: () => valRef.current, set: (v) => cbRef.current(v) })
        e.target.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }}
      onBlur={() => {
        // keyboard keys preventDefault on mousedown, so blur means a real tap elsewhere
        window.setTimeout(() => useOsk.getState().closeIf(id), 150)
      }}
      onChange={(e) => {
        onChange(e.target.value)
        if (target?.id === id) bump()
      }}
      className={`min-h-14 w-full rounded-2xl border-2 border-line bg-card px-4 text-xl font-semibold text-ink placeholder:text-ink-faint focus:border-ember focus:outline-none ${className}`}
    />
  )
}

const LAYOUTS = {
  default: [
    'q w e r t y u i o p',
    'a s d f g h j k l',
    "{shift} z x c v b n m ' {bksp}",
    '{numbers} {space} {done}'
  ],
  shift: [
    'Q W E R T Y U I O P',
    'A S D F G H J K L',
    '{shift} Z X C V B N M ! {bksp}',
    '{numbers} {space} {done}'
  ],
  numbers: ['1 2 3 4 5 6 7 8 9 0', '- / : ; ( ) $ & @ "', '{shift} . , ? ! # % + {bksp}', '{abc} {space} {done}']
}

const DISPLAY = {
  '{bksp}': '⌫',
  '{shift}': '⇧',
  '{space}': ' ',
  '{done}': 'Done',
  '{numbers}': '123',
  '{abc}': 'ABC'
}

/** Bottom-anchored on-screen keyboard, shown whenever an OskInput has focus. */
export function OskTray() {
  const { target, close, echo } = useOsk()
  const keyboardRef = useRef<{ setInput: (v: string) => void } | null>(null)
  const [layout, setLayout] = useState<'default' | 'shift' | 'numbers'>('default')

  useEffect(() => {
    if (target) keyboardRef.current?.setInput(target.get())
    setLayout('default')
  }, [target?.id, echo, target])

  // Any tap that is neither on the keyboard nor on a text input dismisses the
  // tray. Listen to `click` (not pointerdown): closing earlier would reflow the
  // dialog mid-gesture and the tap would land on the moved layout.
  useEffect(() => {
    if (!target) return
    const onClick = (e: MouseEvent): void => {
      const el = e.target as HTMLElement | null
      if (el?.closest('.osl-osk-tray') || el?.tagName === 'INPUT') return
      close()
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [target, close])

  if (!target) return null

  return (
    <div className="osl-osk-tray fixed inset-x-0 bottom-0 z-[60] border-t border-line bg-paper/95 px-3 pt-3 pb-4 shadow-float backdrop-blur-md">
      <div className="mx-auto max-w-4xl">
        <Keyboard
          keyboardRef={(r) => (keyboardRef.current = r)}
          theme="hg-theme-default osl-keyboard"
          layout={LAYOUTS}
          layoutName={layout}
          display={DISPLAY}
          preventMouseDownDefault
          stopMouseDownPropagation
          onChange={(input: string) => target.set(input)}
          onKeyPress={(button: string) => {
            if (button === '{shift}') setLayout((l) => (l === 'shift' ? 'default' : 'shift'))
            else if (button === '{numbers}') setLayout('numbers')
            else if (button === '{abc}') setLayout('default')
            else if (button === '{done}') {
              ;(document.activeElement as HTMLElement | null)?.blur()
              close()
            } else if (layout === 'shift') setLayout('default')
          }}
        />
      </div>
    </div>
  )
}
