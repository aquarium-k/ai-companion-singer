import { runElectron } from './lib/electron.mjs'

const code = await runElectron({ args: process.argv.slice(2) })
process.exit(code)
