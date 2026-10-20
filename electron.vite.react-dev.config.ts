// The real build config with the renderer compiled as React DEVELOPMENT — for probes only.
//
// WHY IT EXISTS: StrictMode double-invokes effects in development builds and never in production,
// so a production build cannot show a StrictMode bug — scripts/drafts-app-probe.mjs proved that
// directly: removing the draft flush's "only if typed here" guard fails 3 checks on this build and
// passes all of them on `npm run build`. `NODE_ENV=development electron-vite build` does NOT get you
// here: electron-vite 2 emits a byte-identical production bundle, silently. The mode has to be set
// on the renderer config itself.
//
//   npm run build:react-dev && EXPECT_REACT=development npm run probe:drafts
//
// Never ship from this: it is unminified dev React. `npm run build` puts production back.
import base from './electron.vite.config'

const b = base as Record<string, any>

export default {
  ...b,
  renderer: {
    ...b.renderer,
    mode: 'development',
    define: { ...(b.renderer?.define ?? {}), 'process.env.NODE_ENV': JSON.stringify('development') },
    build: { ...(b.renderer?.build ?? {}), minify: false }
  }
}
