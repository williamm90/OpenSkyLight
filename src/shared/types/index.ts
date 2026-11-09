export type PersonRole = 'parent' | 'child'

export interface PersonDto {
  id: string
  name: string
  color: string
  role: PersonRole
  sortOrder: number
  /** small JPEG/PNG data URL, or null to show the initial */
  photo: string | null
  /** reward this person's sticker card works toward */
  goalRewardId: string | null
}

export interface PersonCreateInput {
  name: string
  color: string
  role: PersonRole
  photo?: string | null
}

export interface PersonUpdateInput {
  id: string
  name?: string
  color?: string
  role?: PersonRole
  sortOrder?: number
  photo?: string | null
  goalRewardId?: string | null
}

/** Someone the kids can call with one tap. */
export interface ContactDto {
  id: string
  name: string
  /** E.164-ish phone number, e.g. +15551234567 */
  phone: string
  photo: string | null
  color: string
  sortOrder: number
}

export interface ContactCreateInput {
  name: string
  phone: string
  photo?: string | null
  color: string
}

export interface ContactUpdateInput {
  id: string
  name?: string
  phone?: string
  photo?: string | null
  color?: string
  sortOrder?: number
}

export type CalendarProvider = 'local' | 'google' | 'ics'

export interface CalendarDto {
  id: string
  provider: CalendarProvider
  name: string
  color: string
  readOnly: boolean
  visible: boolean
}

export interface CalendarCreateInput {
  name: string
  color: string
}

export interface CalendarUpdateInput {
  id: string
  name?: string
  color?: string
  visible?: boolean
}

export type RecurrenceFreq = 'daily' | 'weekly' | 'monthly' | 'yearly'

/** Simplified recurrence model used by the UI; converted to/from RRULE strings. */
export interface RecurrenceInput {
  freq: RecurrenceFreq
  interval?: number
  /** 0 = Monday ... 6 = Sunday (rrule convention) */
  byWeekdays?: number[]
  /** ISO date (inclusive last day the rule applies) */
  untilDate?: string
  count?: number
}

export type EventStatus = 'confirmed' | 'cancelled'

export interface EventDto {
  id: string
  calendarId: string
  title: string
  description: string | null
  location: string | null
  /** UTC ISO instant */
  startAt: string
  endAt: string
  /** IANA zone the event was created in */
  tz: string
  allDay: boolean
  rrule: string | null
  recurrence: RecurrenceInput | null
  recurringEventId: string | null
  originalStartAt: string | null
  status: EventStatus
  readOnly: boolean
  personIds: string[]
}

export interface OccurrenceDto {
  /** Unique per occurrence: `${eventId}|${occurrenceStart}` */
  key: string
  /** Row that holds this occurrence's data (exception row id if overridden) */
  eventId: string
  /** Master series row id (= eventId when not an exception) */
  masterId: string
  calendarId: string
  title: string
  location: string | null
  /** UTC ISO instants */
  start: string
  end: string
  allDay: boolean
  isRecurring: boolean
  readOnly: boolean
  /** Original (pre-override) start; the key used for `this`/`following` edits */
  occurrenceStart: string
  personIds: string[]
}

export interface EventPatch {
  title?: string
  description?: string | null
  location?: string | null
  start?: string
  end?: string
  tz?: string
  allDay?: boolean
  personIds?: string[]
  /** undefined = leave unchanged; null = remove recurrence */
  recurrence?: RecurrenceInput | null
}

export interface EventCreateInput {
  calendarId: string
  title: string
  description?: string | null
  location?: string | null
  start: string
  end: string
  tz: string
  allDay: boolean
  personIds: string[]
  recurrence?: RecurrenceInput | null
}

export type EditScope = 'this' | 'following' | 'all'

export interface EventUpdateInput {
  id: string
  scope: EditScope
  /** Required when scope is 'this' or 'following' on a recurring event */
  occurrenceStart?: string
  changes: EventPatch
}

export interface EventDeleteInput {
  id: string
  scope: EditScope
  occurrenceStart?: string
}

export type CalendarViewKind = 'home' | 'day' | 'week' | 'month' | 'agenda' | 'chores' | 'lists'

export type HomeTileType =
  | 'todayEvents'
  | 'weekAgenda'
  | 'weather'
  | 'choresProgress'
  | 'starBalances'
  | 'list'
  | 'meals'
  | 'clock'
  | 'photo'
  | 'news'
  | 'camera'
  | 'birdnet'
  | 'timer'
  | 'callFamily'
  | 'stickers'
  | 'googleHome'
  | 'nestCamera'

export interface HomeTileConfig {
  /** 'list' tiles: which list to show */
  listId?: string
  /** 'news' tiles: which preset feed (see shared/rss.ts) */
  feedId?: string
  /** 'camera' tiles: which configured camera to stream */
  cameraId?: string
  /** 'birdnet' tiles: the BirdNET-Go base URL on the LAN */
  birdnetUrl?: string
  /** 'nestCamera' tiles: Google Device Access device id */
  nestDeviceId?: string
}

/** A Google Home / Nest camera from Device Access. */
export interface NestCameraDto {
  id: string
  name: string
  room: string | null
  /** false for older cameras that only offer RTSP (not playable on the tablet yet) */
  webrtc: boolean
}

export interface NestStatusDto {
  configured: boolean
  connected: boolean
  projectId: string | null
  error: string | null
}

export interface CameraDto {
  id: string
  name: string
}

export interface HomeTile {
  id: string
  type: HomeTileType
  /** grid cell coords (0-based) and spans */
  x: number
  y: number
  w: number
  h: number
  config?: HomeTileConfig
}

export type ListKind = 'grocery' | 'todo' | 'custom'

export interface ListItemDto {
  id: string
  text: string
  checked: boolean
  sortOrder: number
}

export interface ListDto {
  id: string
  name: string
  color: string
  kind: ListKind
  items: ListItemDto[]
}

export type MealSlotKind = 'breakfast' | 'lunch' | 'dinner' | 'snack'

export const MEAL_SLOTS: MealSlotKind[] = ['breakfast', 'lunch', 'dinner', 'snack']

export interface MealSlotDto {
  /** YYYY-MM-DD */
  date: string
  slot: MealSlotKind
  text: string
}

export type ChoreRoutine = 'morning' | 'evening' | null

export interface ChoreDto {
  id: string
  title: string
  icon: string | null
  personId: string
  starsValue: number
  /** null = one-time chore on anchorDate */
  recurrence: RecurrenceInput | null
  /** YYYY-MM-DD; first day the chore applies (and the only day for one-offs) */
  anchorDate: string
  routine: ChoreRoutine
  active: boolean
  sortOrder: number
}

export interface ChoreCreateInput {
  title: string
  personId: string
  starsValue: number
  recurrence?: RecurrenceInput | null
  anchorDate?: string
  routine?: ChoreRoutine
}

export interface ChoreUpdateInput {
  id: string
  title?: string
  personId?: string
  starsValue?: number
  recurrence?: RecurrenceInput | null
  anchorDate?: string
  routine?: ChoreRoutine
  active?: boolean
}

export interface DayChoreDto {
  choreId: string
  title: string
  icon: string | null
  personId: string
  starsValue: number
  routine: ChoreRoutine
  completed: boolean
}

export interface StarBalanceDto {
  personId: string
  balance: number
}

export interface RewardDto {
  id: string
  title: string
  icon: string | null
  costStars: number
  active: boolean
}

export interface RedemptionDto {
  id: string
  rewardId: string
  rewardTitle: string
  personId: string
  starsSpent: number
  redeemedAt: string
  status: 'pending' | 'granted'
}

export interface AppSettings {
  /** 0 = Sunday, 1 = Monday */
  weekStartsOn: 0 | 1
  defaultView: CalendarViewKind
  timeFormat: '12h' | '24h'
  temperatureUnit: 'f' | 'c'
  /** 'auto' = dark from sunset to sunrise (sun times from the weather location) */
  theme: 'light' | 'dark' | 'auto'
  weather: { lat: number; lon: number; label: string } | null
  sleep: { enabled: boolean; start: string; end: string }
  screensaver: { folder: string | null; idleMinutes: number }
  launchOnStartup: boolean
  homeLayout: HomeTile[]
  /** LAN companion web app (phones editing lists/meals/chores) */
  companion: { enabled: boolean; port: number }
  /** iCloud shared album ("Public Website" link) for family photos */
  album: { url: string | null }
  /**
   * How call buttons dial: 'tel' hands a tel: link to Android (pick Google
   * Voice once as the default); 'googleVoice' targets the Google Voice app
   * directly with an Android intent link.
   */
  calling: { method: 'tel' | 'googleVoice' }
  /** Cameras tile: open the Google Home app or website; ask for the parent PIN first? */
  cameras: {
    open: 'app' | 'web'
    requirePin: boolean
    /** Live camera tiles: start when tapped (easy on battery cameras) or stay live while on screen */
    live: 'tap' | 'always'
  }
  /**
   * Built-in on-screen keyboard. 'auto' = on in the desktop app, off in a
   * browser (tablets bring their own keyboard).
   */
  onScreenKeyboard: 'auto' | 'on' | 'off'
}

import { DEFAULT_HOME_LAYOUT } from '../home'

export const DEFAULT_SETTINGS: AppSettings = {
  weekStartsOn: 0,
  defaultView: 'home',
  timeFormat: '12h',
  temperatureUnit: 'f',
  theme: 'auto',
  weather: null,
  sleep: { enabled: false, start: '21:30', end: '06:30' },
  screensaver: { folder: null, idleMinutes: 10 },
  launchOnStartup: false,
  homeLayout: DEFAULT_HOME_LAYOUT,
  companion: { enabled: false, port: 8420 },
  album: { url: null },
  calling: { method: 'googleVoice' },
  cameras: { open: 'app', requirePin: true, live: 'tap' },
  onScreenKeyboard: 'auto'
}

/** Touch-friendly person color palette (Skylight-style) */
export const PERSON_COLORS = [
  '#E5484D', // red
  '#F76B15', // orange
  '#FFB224', // amber
  '#46A758', // green
  '#12A594', // teal
  '#0091FF', // blue
  '#6E56CF', // violet
  '#D6409F', // pink
  '#8E4EC6', // purple
  '#00749E' // deep cyan
] as const

export const CALENDAR_COLORS = PERSON_COLORS
