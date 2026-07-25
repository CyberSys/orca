// Why: the global diagnostic switch must not expose precise allocation timing to arbitrary sites.
export const ORCA_BROWSER_GUEST_WEB_PREFERENCES = {
  disableBlinkFeatures: 'PreciseMemoryInfo',
  disableHtmlFullscreenWindowResize: true
} as const

export const ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE =
  'disableBlinkFeatures=PreciseMemoryInfo,disableHtmlFullscreenWindowResize=true'
