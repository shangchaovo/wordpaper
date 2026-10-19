'use strict';
/* Stable desktop-wallpaper files.
 *
 * macOS 14+ copies every image passed to NSWorkspace.setDesktopImageURL into
 * ~/Library/Containers/com.apple.wallpaper.extension.image/.../Caches/<UUID>.png
 * and lists that copy under 系统设置 → 墙纸 → 你的照片. A new path, a replaced
 * inode, or a second setDesktopImageURL on the cache UUID all mint another card.
 * Refreshes therefore overwrite one of two fixed slot files in place and call
 * setDesktopImageURL only when the desktop is not already showing one of them.
 */

const path = require('path');

const STABLE_NAMES = new Set([
  'wallpaper-slot0.png',
  'wallpaper-slot1.png',
  'custom-slot0.png',
  'custom-slot1.png',
]);

function slotKey(prefix) {
  return prefix === 'custom' ? 'custom' : 'wallpaper';
}

function slotFile(root, prefix) {
  return path.join(root, `${slotKey(prefix)}-slot0.png`);
}

function isOurWallpaperFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  return STABLE_NAMES.has(path.basename(filePath));
}

function isWallpaperExtensionCachePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  return filePath.includes('/com.apple.wallpaper.extension.image/')
    || filePath.includes('/com.apple.wallpaper.caches/');
}

function fileNameFromUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const clean = url.split('?')[0];
  let base = '';
  try { base = path.basename(decodeURIComponent(clean)); }
  catch { base = path.basename(clean); }
  return base;
}

/* Timestamped wallpaper-YYYYMMDD-HHMMSS.png names are the old per-refresh
 * files. The two slot names are the only ones we still publish. */
function isLegacyWallpaperFileName(name) {
  if (!name || STABLE_NAMES.has(name)) return false;
  return /^(wallpaper|custom)-.+\.png$/.test(name);
}

function isLegacyWallpaperUrl(url) {
  return isLegacyWallpaperFileName(fileNameFromUrl(url));
}

/* currentPath: what the desktop is showing right now.
 * targetPath: our stable slot file (already rendered).
 * ownedCachePath: a cache UUID a previous set of ours handed back, if any.
 * cacheExists: whether ownedCachePath is still on disk. Never create one.
 *
 * setPath is the only path that may be passed to setDesktopImageURL.
 * updatePath, when set, is an existing file to overwrite in place.
 */
function resolveWallpaperPublish({ currentPath, targetPath, ownedCachePath, cacheExists }) {
  if (!isOurWallpaperFile(targetPath)) {
    throw new Error('wallpaper target must be a stable slot file');
  }
  const inCache = isWallpaperExtensionCachePath(currentPath);
  const ownedCache = !!(ownedCachePath && currentPath === ownedCachePath && inCache);
  const showingOurs = isOurWallpaperFile(currentPath) || ownedCache;
  // A missing cache file must not be recreated: that is a new picture card.
  // Fall back to one import of the stable slot instead.
  if (showingOurs && !(inCache && cacheExists === false)) {
    return {
      mode: 'reuse',
      setPath: null,
      updatePath: currentPath === targetPath ? null : currentPath,
    };
  }
  return { mode: 'set', setPath: targetPath, updatePath: null };
}

function writeBufferInPlace(fs, dest, buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (!fs.existsSync(dest)) {
    const tmp = `${dest}.partial`;
    fs.writeFileSync(tmp, buf);
    try { fs.renameSync(tmp, dest); }
    catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* already gone */ }
      throw err;
    }
    return { created: true };
  }
  const fd = fs.openSync(dest, 'r+');
  try {
    let off = 0;
    while (off < buf.length) {
      const n = fs.writeSync(fd, buf, off, buf.length - off, off);
      if (n <= 0) throw new Error('short write');
      off += n;
    }
    fs.ftruncateSync(fd, buf.length);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return { created: false };
}

module.exports = {
  STABLE_NAMES,
  slotFile,
  isOurWallpaperFile,
  isWallpaperExtensionCachePath,
  isLegacyWallpaperFileName,
  isLegacyWallpaperUrl,
  resolveWallpaperPublish,
  writeBufferInPlace,
};
