// Copies the private receipts bucket to/from a local directory with the secret key (operator only).
// Usage: node storage.mjs export <dir>   (SUPABASE_URL, SUPABASE_SECRET_KEY)
//        node storage.mjs import <dir>   (RESTORE_SUPABASE_URL, RESTORE_SECRET_KEY)
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const BUCKET = 'receipts'
const [mode, dir] = process.argv.slice(2)
if (!['export', 'import'].includes(mode) || !dir) {
  console.error('usage: storage.mjs export|import <dir>')
  process.exit(2)
}

const url = mode === 'export' ? process.env.SUPABASE_URL : process.env.RESTORE_SUPABASE_URL
const key = mode === 'export' ? process.env.SUPABASE_SECRET_KEY : process.env.RESTORE_SECRET_KEY
if (!url || !key) throw new Error('storage credentials missing')
const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
const root = join(dir, BUCKET)

async function listAll(prefix = '') {
  const out = []
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.storage.from(BUCKET).list(prefix, { limit: 1000, offset })
    if (error) throw error
    for (const entry of data) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.id === null) out.push(...(await listAll(path)))
      else out.push({ path, mimetype: entry.metadata?.mimetype })
    }
    if (data.length < 1000) return out
  }
}

async function walk(base) {
  const out = []
  for (const entry of await readdir(base, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(join(entry.parentPath, entry.name))
  }
  return out
}

if (mode === 'export') {
  const objects = await listAll()
  for (const { path } of objects) {
    const { data, error } = await client.storage.from(BUCKET).download(path)
    if (error) throw error
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, Buffer.from(await data.arrayBuffer()))
  }
  await writeFile(join(dir, 'objects.json'), JSON.stringify(objects, null, 2))
  console.log(`Exported ${objects.length} objects`)
} else {
  const types = new Map(JSON.parse(await readFile(join(dir, 'objects.json'), 'utf8')).map((o) => [o.path, o.mimetype]))
  let count = 0
  for (const file of await walk(root).catch(() => [])) {
    const path = relative(root, file).split('\\').join('/')
    const { error } = await client.storage
      .from(BUCKET)
      .upload(path, await readFile(file), { contentType: types.get(path) ?? 'application/octet-stream', upsert: false })
    if (error) throw error
    count++
  }
  console.log(`Imported ${count} objects`)
}
