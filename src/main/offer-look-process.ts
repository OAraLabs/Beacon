// The helper process that looks at and reads offered files (offer-look.ts says why it is a
// process of its own). Started by main with utilityProcess.fork (offer-looker.ts); it does
// nothing until asked, answers only main, and holds no Beacon state.
import { answer, type LookAsk } from './offer-look'

process.parentPort.on('message', (e) => {
  answer(e.data as LookAsk, (a) => process.parentPort.postMessage(a))
})
