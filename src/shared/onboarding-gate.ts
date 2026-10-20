// Is the v0.4.0 onboarding allowed on screen in this build?
//
// WHY A GATE. The new first run is built one small PR at a time (docs/ONBOARDING-v0.4.0.md, §6). Until
// the last of them lands, it has paths that end in a stand-in, and main can be released at any time.
// So it is closed in every build that could ship, and opened only deliberately:
//
//   * a release build never shows it, whatever is in its environment;
//   * a dev run (`electron .`) or a probe build shows it when BEACON_ONBOARDING=v4;
//   * the go-live PR flips ONBOARDING_V4_LIVE, and not before: smoke:onboarding refuses that flip
//     while any screen is still a stand-in (PENDING_SCREENS in ./onboarding).
//
// The build-flavour half is not new logic. It is the one decision that already refuses DevTools and
// remote debugging to a release build (./release-gate debuggingAllowed), reused so that "a build that
// is locked down" means the same thing everywhere: a flavour this code does not know, or a packaged
// build with no flag, is closed.
//
// No Node/Electron imports (same rule as the rest of src/shared).
import { debuggingAllowed } from './release-gate'

/** Flipped by the go-live PR (and only that one). false = the existing wizard is the first run in
 *  every build that has no BEACON_ONBOARDING=v4. Typed boolean so the compiler does not fold it. */
export const ONBOARDING_V4_LIVE: boolean = true

/** The environment value that opens the gate on a non-release build. */
export const ONBOARDING_ENV_VALUE = 'v4'

export function onboardingV4Visible(input: { flavor: string | null; isPackaged: boolean; env: string | undefined }): boolean {
  if (ONBOARDING_V4_LIVE) return true
  return debuggingAllowed(input.flavor, input.isPackaged) && input.env === ONBOARDING_ENV_VALUE
}
