// What Beacon calls the computer it runs on, in words a person reads: "this Mac" on macOS, "this computer" everywhere else (a Linux user
// was told about "the key saved on this Mac"). The page reads the platform from the bridge (window.beacon.platform).
//
// No Node/Electron imports (same rule as the rest of src/shared).

export function thisComputer(platform: string): string {
  return platform === 'darwin' ? 'this Mac' : 'this computer'
}

/** The banner's line when the saved Prometheus turned down the key Beacon holds. */
export function rejectedKeyLine(platform: string): string {
  return `It turned down the key saved on ${thisComputer(platform)}. Change the connection to enter a new one.`
}
