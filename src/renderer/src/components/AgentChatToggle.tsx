import type { ChatMode } from '@shared/composer-controls'
import { Icon } from './Icon'

// Agent | Chat | Voice per-message control (Composer-controls sprint; Voice added 2026-09-03 per
// the design handoff's R4). Sets the `mode` field on the send payload (Prometheus #72): Agent omits
// it (byte-identical default); Chat sends `mode: 'chat'` (a no-tools turn). The segmented control
// IS the always-visible mode indicator — the active segment is highlighted and labeled, so "am I in
// Chat right now?" is answerable at a glance at the moment of sending.
//
// WHY VOICE IS A SEGMENT AND NOT A BUTTON. R4: sort controls by JOB. Dictation is an INPUT METHOD
// (it types into this draft and sends nothing) and lives in the icon row; a voice TURN is a send;
// but hands-free is a CONVERSATION MODE — it changes how the whole exchange runs, which is the
// same kind of thing Agent and Chat are. So it is the third segment, not a fourth glyph.
//
// It is NOT a third `ChatMode`. Hands-free is capture state, not a send field, and widening the
// mode union would put a value on the wire the daemon has no meaning for. The segment reads as
// active while hands-free is on and hands the highlight back to Agent/Chat when it stops.

export function AgentChatToggle({
  mode,
  onChange,
  disabled,
  chatDisabled,
  chatDisabledReason,
  voicePhase,
  onVoiceToggle,
  voiceDisabled
}: {
  mode: ChatMode
  onChange: (m: ChatMode) => void
  disabled?: boolean
  /** Lock the Chat option (e.g. attachments are staged → the send must run Agent). Keeps the
   *  indicator honest: Chat can't be selected when the actual send would be Agent. */
  chatDisabled?: boolean
  chatDisabledReason?: string
  /** Hands-free phase, owned by MainView. Absent → the Voice segment is not rendered at all
   *  (the pop-out and any caller without the machinery keeps the two-segment control). */
  voicePhase?: 'off' | 'listening' | 'capturing' | 'processing' | 'speaking'
  onVoiceToggle?: () => void
  /** A push-to-talk turn is in flight — Voice cannot be entered mid-turn. */
  voiceDisabled?: boolean
}) {
  const voiceOn = voicePhase !== undefined && voicePhase !== 'off'
  return (
    <div className="mode-toggle" role="group" aria-label="Turn mode">
      <button
        type="button"
        className={`mode-opt${mode === 'agent' && !voiceOn ? ' is-active' : ''}`}
        aria-pressed={mode === 'agent' && !voiceOn}
        disabled={disabled}
        onClick={() => onChange('agent')}
        title="Agent — the model can use tools this turn"
      >
        Agent
      </button>
      <button
        type="button"
        className={`mode-opt${mode === 'chat' && !voiceOn ? ' is-active' : ''}`}
        aria-pressed={mode === 'chat' && !voiceOn}
        disabled={disabled || chatDisabled}
        onClick={() => onChange('chat')}
        title={chatDisabled ? (chatDisabledReason ?? 'Chat unavailable') : 'Chat — no tools this turn (plain reply)'}
      >
        Chat
      </button>
      {onVoiceToggle && voicePhase !== undefined ? (
        <button
          type="button"
          className={`mode-opt mode-opt-voice${voiceOn ? ' is-active' : ''}${voicePhase === 'processing' ? ' is-busy' : ''}`}
          aria-pressed={voiceOn}
          disabled={disabled || voiceDisabled}
          onClick={onVoiceToggle}
          title={
            voiceOn
              ? `Voice mode is on (${voicePhase}) — click to leave it`
              : 'Voice — keep listening; speak to talk, talk over the reply to interrupt'
          }
        >
          <Icon name="radio" size={12} />
          Voice
        </button>
      ) : null}
    </div>
  )
}
