/**
 * Apple and Outlook hand out calendar links as webcal:// (or webcals://),
 * which is just "HTTPS, but open my calendar app". Fetch them over https.
 */
export function normalizeFeedUrl(raw: string): string {
  const trimmed = raw.trim()
  return trimmed.replace(/^webcals?:\/\//i, 'https://')
}
