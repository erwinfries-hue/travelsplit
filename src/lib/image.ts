// Receipt photo preparation in the browser: re-encoding through a canvas drops all EXIF data
// (including GPS position) and keeps uploads small enough for the free storage quota.

export const RECEIPT_TARGET_BYTES = 250 * 1024
export const RECEIPT_MAX_BYTES = 1024 * 1024
export const RECEIPT_MAX_EDGE = 2560

/** Scale (w, h) down so that the longer edge is at most `maxEdge`; never scales up. */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return { width, height }
  const factor = maxEdge / longest
  return { width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)) }
}

/** Quality/size steps tried in order until the result fits the target. */
export const COMPRESSION_STEPS: readonly { maxEdge: number; quality: number }[] = [
  { maxEdge: RECEIPT_MAX_EDGE, quality: 0.82 },
  { maxEdge: 2048, quality: 0.75 },
  { maxEdge: 1600, quality: 0.7 },
  { maxEdge: 1280, quality: 0.65 },
  { maxEdge: 1024, quality: 0.6 },
]

export class ImageError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new ImageError('image_unreadable'))), 'image/jpeg', quality),
  )
}

/** Returns a JPEG without metadata, aiming at RECEIPT_TARGET_BYTES and never above RECEIPT_MAX_BYTES. */
export async function compressReceipt(file: Blob): Promise<Blob> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new ImageError('image_unreadable')
  }
  try {
    let best: Blob | null = null
    for (const step of COMPRESSION_STEPS) {
      const { width, height } = fitWithin(bitmap.width, bitmap.height, step.maxEdge)
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new ImageError('image_unreadable')
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(bitmap, 0, 0, width, height)
      best = await toBlob(canvas, step.quality)
      if (best.size <= RECEIPT_TARGET_BYTES) break
    }
    if (!best || best.size > RECEIPT_MAX_BYTES) throw new ImageError('image_too_large')
    return best
  } finally {
    bitmap.close()
  }
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
