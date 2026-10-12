// SEC-15: fail if the production bundle contains anything that looks like a privileged key.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DIST = 'dist'
const patterns = [
  { name: 'service_role JWT', re: /eyJ[\w-]+\.eyJ[\w-]*c2VydmljZV9yb2xl[\w-]*\.[\w-]+/ },
  { name: 'Supabase secret key', re: /sb_secret_[\w-]{10,}/ },
  { name: 'Postgres connection string', re: /postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@/ },
  { name: 'Google client secret', re: /GOCSPX-[\w-]{10,}/ },
  { name: 'Private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
]

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* walk(path)
    else yield path
  }
}

let findings = 0
for (const file of walk(DIST)) {
  const text = readFileSync(file, 'utf8')
  for (const { name, re } of patterns) {
    if (re.test(text)) {
      console.error(`SEC-15 FAIL: ${name} found in ${file}`)
      findings++
    }
  }
}
if (findings > 0) process.exit(1)
console.log('SEC-15 PASS: no privileged secrets found in dist/')
