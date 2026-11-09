import { useEffect, useRef, useState } from 'react'
import type { PersonDto, RewardDto } from '@shared/types'
import { cardState, stickerFor } from '@shared/stickers'
import { useBalances, usePeople, useRewardMutations, useRewards } from '../../api/hooks'
import { Avatar } from '../../components/Avatar'
import { useToasts } from '../../stores/toastStore'

/**
 * One child's sticker card: a grid of spots that fill with stickers as chores
 * get done. When it's full the child taps "I did it!", which sends the reward
 * to a parent for approval (stars are spent then, so the card starts over).
 */
export function StickerCard({
  person,
  goal,
  balance,
  size = 'large'
}: {
  person: PersonDto
  goal: RewardDto | null
  balance: number
  size?: 'large' | 'small'
}) {
  const mutations = useRewardMutations()
  const pushToast = useToasts((s) => s.push)
  const small = size === 'small'

  // remember what was filled last render so only NEW stickers pop in
  const prevFilled = useRef<number | null>(null)
  const state = goal ? cardState(balance, goal.costStars) : null
  const filled = state?.filled ?? 0
  const popFrom = prevFilled.current ?? filled
  useEffect(() => {
    prevFilled.current = filled
  }, [filled])

  const header = (
    <div className="flex items-center gap-3">
      <Avatar name={person.name} color={person.color} photo={person.photo} size={small ? 36 : 56} />
      <div className="min-w-0 flex-1">
        <div className={`truncate font-bold ${small ? 'text-base' : 'text-2xl'}`}>{person.name}</div>
        {goal && state && (
          <div className={`truncate font-bold text-ink-faint ${small ? 'text-xs' : 'text-base'}`}>
            {state.full ? `Card full! Goal: ${goal.title}` : `${state.remaining} to go → ${goal.title}`}
          </div>
        )}
      </div>
    </div>
  )

  if (!goal || !state) {
    return (
      <div className="flex flex-col gap-2 rounded-card p-3" style={{ backgroundColor: `${person.color}14` }}>
        {header}
        <div className={`font-bold text-ink-faint ${small ? 'text-xs' : 'text-base'}`}>
          ⭐ {balance} sticker{balance === 1 ? '' : 's'}. Ask a parent to pick a goal!
        </div>
      </div>
    )
  }

  const claim = (): void => {
    mutations.redeem.mutate(
      { rewardId: goal.id, personId: person.id },
      { onSuccess: () => pushToast(`🎉 ${person.name} finished a card! A parent will approve "${goal.title}".`) }
    )
  }

  const cols = state.spots <= 10 ? 5 : state.spots <= 20 ? 5 : 6
  return (
    <div
      className={`flex flex-col rounded-card ${small ? 'gap-2 p-2.5' : 'gap-4 p-5'}`}
      style={{ backgroundColor: `${person.color}14`, border: `2px dashed ${person.color}66` }}
    >
      {header}
      <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${small ? Math.min(10, state.spots) : cols}, minmax(0, 1fr))` }}>
        {Array.from({ length: state.spots }, (_, i) => {
          const has = i < state.filled
          const isNew = has && i >= popFrom
          return (
            <div
              key={i}
              className={`flex aspect-square items-center justify-center rounded-full ${has ? '' : 'border-2 border-dashed'}`}
              style={{
                borderColor: has ? undefined : `${person.color}55`,
                backgroundColor: has ? 'var(--color-card, #fff)' : 'transparent',
                fontSize: small ? '1.05rem' : '2.1rem',
                lineHeight: 1
              }}
            >
              {has && (
                <span className={isNew ? 'animate-sticker' : ''} style={isNew ? { animationDelay: `${(i - popFrom) * 120}ms` } : undefined}>
                  {stickerFor(person.id, i)}
                </span>
              )}
            </div>
          )
        })}
      </div>
      {state.starsPerSpot > 1 && !small && (
        <div className="text-sm font-bold text-ink-faint">Each sticker = {state.starsPerSpot} stars</div>
      )}
      {state.full && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            claim()
          }}
          disabled={mutations.redeem.isPending}
          className={`pressable animate-pop rounded-2xl bg-ember font-extrabold text-white shadow-card ${small ? 'min-h-10 text-base' : 'min-h-16 text-2xl'}`}
        >
          🎉 I did it!
        </button>
      )}
    </div>
  )
}

/** Every child's card. Used on the chores screen and in the full-screen sheet. */
export function StickerCards({ size = 'large' }: { size?: 'large' | 'small' }) {
  const { data: people = [] } = usePeople()
  const { data: rewards = [] } = useRewards()
  const { data: balances = [] } = useBalances()
  const kids = people.filter((p) => p.role === 'child')
  if (kids.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-2 text-center text-sm font-bold text-ink-faint">
        Add your kids in Settings → Family to give them sticker cards
      </div>
    )
  }
  return (
    <div className={`grid min-h-0 gap-3 ${size === 'small' ? 'grid-cols-1 overflow-hidden' : 'grid-cols-[repeat(auto-fit,minmax(20rem,1fr))]'}`}>
      {kids.map((p) => (
        <StickerCard
          key={p.id}
          person={p}
          size={size}
          goal={rewards.find((r) => r.id === p.goalRewardId) ?? null}
          balance={balances.find((b) => b.personId === p.id)?.balance ?? 0}
        />
      ))}
    </div>
  )
}

/** A short burst on screen when a chore earns a sticker. */
export function useStickerBurst(): { burst: (personId: string, spot: number) => void; node: React.ReactNode } {
  const [current, setCurrent] = useState<{ emoji: string; key: number } | null>(null)
  useEffect(() => {
    if (!current) return
    const t = window.setTimeout(() => setCurrent(null), 1400)
    return () => window.clearTimeout(t)
  }, [current])
  return {
    burst: (personId, spot) => setCurrent({ emoji: stickerFor(personId, spot), key: Date.now() }),
    node: current ? (
      <div key={current.key} className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center">
        <div className="animate-sticker-burst text-[10rem] drop-shadow-xl">{current.emoji}</div>
      </div>
    ) : null
  }
}
