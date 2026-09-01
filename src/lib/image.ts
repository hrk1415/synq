/**
 * Client-side image resize → JPEG data URL.
 *
 * Profile photos are stored as base64 on the user record (no blob service), so
 * they must be small. This downscales to `max`px on the longest edge and
 * re-encodes as JPEG, which brings a multi-MB camera photo down to ~10-30 KB —
 * safe to keep in the DB and cheap to ship over the chat/profile APIs.
 *
 * Browser-only (uses FileReader / Image / canvas). Call it from event handlers,
 * never on the server.
 */
export async function resizeImageToDataUrl(
  file: File,
  max = 256,
  quality = 0.8,
): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Please choose an image file.');
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('That file is not a valid image.'));
    el.src = dataUrl;
  });

  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available in this browser.');
  ctx.drawImage(img, 0, 0, w, h);

  // JPEG keeps profile photos tiny; transparency isn't needed for avatars.
  return canvas.toDataURL('image/jpeg', quality);
}
