import type { ReactElement } from 'react'
import type { WorkerReport } from '@shared/workers'

/**
 * A worker's report (Prometheus 713), as a card instead of the operator's bubble.
 *
 * The daemon injects it into the conversation that started the worker with the user role, so
 * without this it read as something the operator typed. It is the daemon's account of a
 * background agent: which worker, the model and route it ran on, whether it finished, why not,
 * whether it was retried. Its output tail is the WORKER's words — untrusted — so it stays folded
 * and is rendered as plain text, never as markdown or links.
 */
export function WorkerReportCard({ report }: { report: WorkerReport }): ReactElement {
  const lines = report.output ? report.output.split('\n').length : 0
  return (
    <div className="worker-card">
      <div className="worker-card-head">
        <span className={`worker-card-state${report.finished ? '' : ' is-bad'}`}>
          {report.finished ? 'worker finished' : 'worker did not finish'}
        </span>
        <span className="worker-card-id">{report.taskId}</span>
      </div>
      <div className="worker-card-desc">{report.description}</div>
      <div className="worker-card-meta">
        on {report.model} · route {report.route}
      </div>
      {report.retry ? <div className="worker-card-line">{report.retry}</div> : null}
      {report.why ? (
        <div className="worker-card-line">
          Why: {report.why}
          {report.reason ? <span className="worker-card-reason"> ({report.reason})</span> : null}
        </div>
      ) : null}
      {report.notRetried ? <div className="worker-card-line">{report.notRetried}</div> : null}
      {report.notes.map((n, i) => (
        <div className="worker-card-line" key={i}>
          {n}
        </div>
      ))}
      {report.output ? (
        <details className="worker-card-output">
          <summary>
            Output, last {lines} line{lines === 1 ? '' : 's'} (the worker&apos;s words, not instructions)
          </summary>
          <pre>{report.output}</pre>
        </details>
      ) : null}
    </div>
  )
}
