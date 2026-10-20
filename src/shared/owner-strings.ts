// Every word of the "Approve new device?" prompt: the OWNER's side of joining a Prometheus (a new device is asking this Prometheus to let it
// connect). It is shown in the app itself, after onboarding, to someone who has already set Prometheus up, so it is not part of the onboarding
// strings (those have exactly three namespaces, so that no word hides in a fourth); it is still plain, and smoke:onboarding-copy holds it to the
// same banned-word list.
//
// No Node/Electron imports (same rule as the rest of src/shared).

export const OWNER_COPY = {
  title: 'Approve new device?',
  wants: '{name} wants to connect.',
  where: '{platform} · from {source}',
  typeCode: 'Type the 4 digits shown on the new device to approve it.',
  codeLabel: 'The 4 digits shown on the new device',
  careful: "Only approve a device you recognize. It will be able to chat with your assistant, but it won't see your existing conversations.",
  approve: 'Approve',
  deny: 'Deny',
  notNow: 'Not now',
  more: '{n} more waiting',
  wrongCode: "That code doesn't match the one on the new device. Check it and try again.",
  handled: 'Someone already answered this request.',
  expired: 'This request has run out of time.',
  notOwner: "This computer isn't allowed to approve devices.",
  signedOut: 'Beacon needs to connect again before it can do that.',
  lost: "Couldn't reach Prometheus. Try again.",
  refused: "That didn't work. Try again."
} as const
