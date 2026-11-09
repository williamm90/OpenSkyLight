export const GOOGLE_HOME_PACKAGE = 'com.google.android.apps.chromecast.app'
export const GOOGLE_HOME_WEB = 'https://home.google.com/'

/**
 * Link the Cameras tile opens. Google Home cameras can't be embedded (Google
 * blocks framing and has no simple stream API), so the tile hands off to Google:
 *  - 'app': Android intent that launches the Google Home app; if it isn't
 *    installed the browser falls back to the website
 *  - 'web': the home.google.com website in the same kiosk browser
 */
export function buildGoogleHomeLink(open: 'app' | 'web'): string {
  if (open === 'web') return GOOGLE_HOME_WEB
  return (
    'intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;' +
    `package=${GOOGLE_HOME_PACKAGE};S.browser_fallback_url=${encodeURIComponent(GOOGLE_HOME_WEB)};end`
  )
}

/** The parent PIN is asked only when one is set, the setting wants it, and the screen is locked. */
export function needsPinForCameras(
  requirePin: boolean,
  auth: { pinSet: boolean; unlocked: boolean } | undefined
): boolean {
  if (!requirePin) return false
  if (!auth) return true // fail closed until auth status loads
  return auth.pinSet && !auth.unlocked
}
