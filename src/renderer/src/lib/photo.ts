/**
 * Turn a picked image file into a small square JPEG data URL (center-cropped),
 * so avatars stay tiny in the database and load instantly on the display.
 */
export async function fileToAvatar(file: File, size = 256, quality = 0.85): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Pick a photo (JPEG, PNG or HEIC from the gallery)')
  const bitmap = await loadBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const sx = (bitmap.width - side) / 2
  const sy = (bitmap.height - side) / 2
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser can’t process photos')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size)
  if ('close' in bitmap) (bitmap as ImageBitmap).close()
  return canvas.toDataURL('image/jpeg', quality)
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    try {
      // honors EXIF rotation, so phone photos aren't sideways
      return await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      // fall through to <img> decoding
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return img
  } finally {
    URL.revokeObjectURL(url)
  }
}
