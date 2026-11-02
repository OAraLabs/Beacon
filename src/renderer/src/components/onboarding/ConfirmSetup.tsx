import { useEffect, useState } from 'react'
import { ConfirmSetupView } from './ConfirmSetupView'

interface Props {
  onConfirm: () => void
  onBack: () => void
}

/** A-confirm: the one decision on path A. It says what will happen (where Prometheus comes from, where it goes, that
 *  it keeps running, and that the checks for a newer one can be turned off) and Prometheus is not downloaded before the
 *  button is pressed. The size is the release manifest's, which main reads in its own step once the screen is up; until it
 *  answers, or when it cannot, the screen says DOWNLOAD_ESTIMATE_MB, so it never waits on the network. */
export function ConfirmSetup({ onConfirm, onBack }: Props): React.JSX.Element {
  const [downloadBytes, setDownloadBytes] = useState<number | null>(null)
  useEffect(() => {
    let live = true
    window.beacon.pathA.downloadSize().then(
      (bytes) => {
        if (live) setDownloadBytes(bytes)
      },
      () => undefined
    )
    return () => {
      live = false
    }
  }, [])
  return <ConfirmSetupView downloadBytes={downloadBytes} onConfirm={onConfirm} onBack={onBack} />
}
