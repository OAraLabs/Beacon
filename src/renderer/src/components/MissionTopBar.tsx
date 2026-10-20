import { ModelSwitcher } from './ModelSwitcher'
import { HostChip } from './HostChip'
import { SkinPicker } from './SkinPicker'

// The Beacon banner for the Mission landing — the same chrome as ChatShell's topbar via the shared
// .topbar CSS, but standalone: Mission has no chat session, so the model pill is READ-ONLY
// ("Local", the local/default) rather than the interactive per-session switcher.
//
// 2026-09-07: the Chats header's host-chip rule applied here. The raw address (`Connected ·
// 203.0.113.9:8010`) becomes the host chip — dot, name, latency, IP in the tooltip — for the
// same reason it left Chats: 19 characters of the most detailed fact available in the most
// prominent slot, and it never changes.
//
// The QUICK SKIN PICKER STAYS — by the owner's call, same day, after it had been removed on the
// argument that the plate is a Config setting rather than a per-surface fact. That argument
// holds for Chats, which keeps its header clean. Mission is different: it is the dashboard, the
// place you look at the whole instrument, and a one-click plate switch beside it is a thing he
// actually used. Config → Skin remains the home of the full grid; this is the shortcut.

export function MissionTopBar() {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-dot" />
        Beacon
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {/* Read-only model pill (no session on Mission) — reuses ModelSwitcher's read-only fallback. */}
        <ModelSwitcher variant="topbar" models={[]} currentKey={null} onSelect={() => undefined} fallbackLabel="Local" />
        <HostChip />
        <SkinPicker />
      </div>
    </header>
  )
}
