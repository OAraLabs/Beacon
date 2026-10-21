import type { ReactElement } from 'react'
import { commandHead, fileName, noticeCaption, unauditedLabel, type MachineNotice } from '@shared/machine-notice'

/**
 * R13: a daemon-injected turn summary, not something a person typed. It renders as the tool result
 * it is — one row per file — instead of a user bubble full of raw machine syntax. The whole block
 * stays in the title.
 *
 * A turn the daemon could NOT audit says so in the caption and gets a row per command it could not
 * read, the command itself folded behind the row. It never comes out as an empty "files touched"
 * list: that reads as a clean audit, the opposite of what the daemon reported.
 */
export function MachineNoticeCard({ notice }: { notice: MachineNotice }): ReactElement {
  return (
    <div className={`machine-notice is-${notice.audit}`} title={notice.raw}>
      <span className="machine-notice-cap">{noticeCaption(notice)}</span>
      {notice.files.map((f, i) => (
        <span
          className="machine-notice-row"
          key={`${f.path}:${i}`}
          title={f.error ? `${f.path}\n${f.error}` : f.path}
        >
          <span className={`machine-notice-dot${f.status === 'ok' ? '' : ' is-bad'}`} aria-hidden />
          <span className="machine-notice-op">{f.op}</span>
          <span className="machine-notice-path">{fileName(f.path)}</span>
          {f.delta ? <span className="machine-notice-delta">{f.delta}</span> : null}
        </span>
      ))}
      {notice.more ? (
        <span className="machine-notice-row machine-notice-more">+{notice.more} more not listed</span>
      ) : null}
      {notice.unaudited.map((u, i) => (
        <details className="machine-notice-unaudited" key={`${u.reason}:${i}`}>
          <summary className="machine-notice-row">
            <span className="machine-notice-dot is-unknown" aria-hidden />
            <span className="machine-notice-op">{unauditedLabel(u)}</span>
            <span className="machine-notice-path">{commandHead(u.command)}</span>
            {u.count > 1 ? <span className="machine-notice-delta">×{u.count}</span> : null}
          </summary>
          <pre>{u.command}</pre>
        </details>
      ))}
      {notice.audit === 'unrecognised' ? (
        <details className="machine-notice-unaudited">
          <summary className="machine-notice-row">
            <span className="machine-notice-dot is-unknown" aria-hidden />
            <span className="machine-notice-op">
              {notice.files.length ? `${notice.unread} line${notice.unread === 1 ? '' : 's'} Beacon could not read` : 'Beacon could not read this notice'}
            </span>
          </summary>
          <pre>{notice.raw}</pre>
        </details>
      ) : null}
    </div>
  )
}
