/**
 * Sticker-card math. One star (from a finished chore) = one sticker. A kid's
 * card has one spot per star their goal reward costs; when it's full they can
 * cash it in for the reward. Pure so the display and the tests agree.
 */

export const STICKERS = [
  '🌟', '🦄', '🚀', '🐶', '🌈', '🍩', '🦖', '🐱', '⚽', '🎈',
  '🐠', '🍓', '🦋', '🐼', '🍕', '🎨', '🐸', '🦊', '🍦', '🐢',
  '🌻', '🐝', '🎸', '🦁', '🐙', '🍉', '🛼', '🐧', '🧁', '🏆'
] as const

/** Big goals still fit on one card; past this, each spot is worth several stars. */
export const MAX_SPOTS = 30

export interface CardState {
  /** number of spots drawn on the card */
  spots: number
  /** spots with a sticker in them */
  filled: number
  /** stars each spot represents (1 unless the goal is bigger than MAX_SPOTS) */
  starsPerSpot: number
  /** card is complete: the reward can be claimed */
  full: boolean
  /** stars still needed */
  remaining: number
}

export function cardState(balance: number, goalCost: number): CardState {
  const cost = Math.max(1, Math.floor(goalCost))
  const have = Math.max(0, Math.floor(balance))
  const starsPerSpot = Math.ceil(cost / MAX_SPOTS)
  const spots = Math.ceil(cost / starsPerSpot)
  const full = have >= cost
  const filled = full ? spots : Math.min(spots, Math.floor(have / starsPerSpot))
  return { spots, filled, starsPerSpot, full, remaining: Math.max(0, cost - have) }
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** Stable sticker for a given spot, so a kid's card doesn't reshuffle on every render. */
export function stickerFor(personId: string, spot: number): string {
  return STICKERS[(hash(personId) + spot * 7) % STICKERS.length]
}
