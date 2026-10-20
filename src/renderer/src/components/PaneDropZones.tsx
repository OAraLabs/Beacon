import { useState, type DragEvent } from 'react'
import { SESSION_DRAG_TYPE } from '@shared/split-panes'

// The drop targets a pane shows while a sidebar session is being dragged (@shared/split-panes):
// left third "open on the left", middle "open here" (replaces this pane), right third "open on the
// right". When there is no room for another pane the side zones say so and open the session in its
// own window instead, so a drop is never silently refused.

export type PaneDropZone = 'left' | 'center' | 'right'

export function PaneDropZones({
  index,
  canSplit,
  onDropSession
}: {
  index: number
  canSplit: boolean
  onDropSession: (index: number, zone: PaneDropZone, sessionId: string) => void
}) {
  const [over, setOver] = useState<PaneDropZone | null>(null)
  const props = (zone: PaneDropZone) => ({
    onDragOver: (e: DragEvent): void => {
      if (!e.dataTransfer.types.includes(SESSION_DRAG_TYPE)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (over !== zone) setOver(zone)
    },
    onDragLeave: (e: DragEvent): void => {
      if (!(e.currentTarget as Node).contains(e.relatedTarget as Node | null)) setOver((o) => (o === zone ? null : o))
    },
    onDrop: (e: DragEvent): void => {
      const id = e.dataTransfer.getData(SESSION_DRAG_TYPE)
      setOver(null)
      if (!id) return
      e.preventDefault()
      onDropSession(index, zone, id)
    }
  })
  const sideLabel = canSplit ? null : 'No room for another pane: drop to open it in its own window'
  return (
    <div className="pane-drop" aria-hidden>
      <div className={`pane-drop-zone is-left${over === 'left' ? ' is-over' : ''}`} {...props('left')}>
        <span>{sideLabel ?? 'Open on the left'}</span>
      </div>
      <div className={`pane-drop-zone is-center${over === 'center' ? ' is-over' : ''}`} {...props('center')}>
        <span>Open here</span>
      </div>
      <div className={`pane-drop-zone is-right${over === 'right' ? ' is-over' : ''}`} {...props('right')}>
        <span>{sideLabel ?? 'Open on the right'}</span>
      </div>
    </div>
  )
}
