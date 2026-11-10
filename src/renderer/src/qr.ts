import qrcode from 'qrcode-generator'

/** SVG, generated locally. Never a hosted image service: a pairing payload can carry a live credential, and a remote QR renderer would
 *  be exfiltrating it by construction. */
export function qrSvg(payload: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(payload)
  qr.make()
  return qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true })
}
