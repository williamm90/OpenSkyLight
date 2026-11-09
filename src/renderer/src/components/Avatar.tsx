import { initials, textOn } from '../lib/format'

/** A person's photo in a colored ring, or their initials when there's no photo. */
export function Avatar({
  name,
  color,
  photo,
  size = 48,
  ring = true,
  className = ''
}: {
  name: string
  color: string
  photo: string | null | undefined
  size?: number
  ring?: boolean
  className?: string
}) {
  const ringWidth = ring ? Math.max(2, Math.round(size / 18)) : 0
  if (photo) {
    return (
      <span
        className={`inline-block shrink-0 overflow-hidden rounded-full bg-paper-deep ${className}`}
        style={{ width: size, height: size, boxShadow: ring ? `0 0 0 ${ringWidth}px ${color}` : undefined }}
      >
        <img src={photo} alt={name} className="h-full w-full object-cover" draggable={false} />
      </span>
    )
  }
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-extrabold ${className}`}
      style={{ width: size, height: size, backgroundColor: color, color: textOn(color), fontSize: size * 0.36 }}
    >
      {initials(name)}
    </span>
  )
}
