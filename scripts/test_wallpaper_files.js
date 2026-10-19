#!/usr/bin/env node
'use strict';
/* Wallpaper files stay on two stable slot names and are overwritten in place.
 * setDesktopImageURL is what copies a new UUID into the wallpaper image
 * extension cache (系统设置 → 墙纸 → 你的照片). This test never starts
 * companion.js and never touches the real desktop. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const wallpaper = require('../lib/wallpaper_files');

const CACHE = '/Users/x/Library/Containers/com.apple.wallpaper.extension.image/Data/Library/Caches/AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE.png';
const OTHER = '/Users/x/Library/Containers/com.apple.wallpaper.extension.image/Data/Library/Caches/BBBBBBBB-BBBB-CCCC-DDDD-EEEEEEEEEEEE.png';
const SONOMA = '/System/Library/Desktop Pictures/Sonoma.heic';

function publishSequence(macOSReturns) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-slot-'));
  const target = wallpaper.slotFile(dir, 'wallpaper');
  let current = SONOMA;
  let owned = '';
  let cacheOnDisk = false;
  let sets = 0;
  const inodes = [];
  try {
    for (let i = 0; i < 20; i++) {
      const body = Buffer.from(`frame-${i}-${'x'.repeat(32 + i)}`);
      const created = wallpaper.writeBufferInPlace(fs, target, body);
      assert.equal(created.created, i === 0);
      assert.equal(fs.readFileSync(target).equals(body), true);
      inodes.push(fs.statSync(target).ino);
      const plan = wallpaper.resolveWallpaperPublish({
        currentPath: current,
        targetPath: target,
        ownedCachePath: owned,
        cacheExists: !wallpaper.isWallpaperExtensionCachePath(current) || cacheOnDisk,
      });
      if (plan.setPath) {
        assert.equal(wallpaper.isWallpaperExtensionCachePath(plan.setPath), false);
        assert.equal(wallpaper.isOurWallpaperFile(plan.setPath), true);
      }
      if (plan.mode === 'set') {
        sets += 1;
        assert.equal(plan.setPath, target);
        assert.equal(plan.updatePath, null);
        if (macOSReturns === 'cache') {
          current = CACHE;
          owned = CACHE;
          cacheOnDisk = true;
        } else {
          current = target;
        }
      } else {
        assert.equal(plan.setPath, null);
        if (plan.updatePath) {
          assert.ok(
            wallpaper.isOurWallpaperFile(plan.updatePath) || wallpaper.isWallpaperExtensionCachePath(plan.updatePath)
          );
          assert.notEqual(plan.updatePath, target);
        }
      }
    }
    assert.equal(sets, 1, `expected one desktop import, got ${sets} (${macOSReturns})`);
    assert.equal(new Set(inodes).size, 1, 'slot file inode changed across refreshes');
    const names = fs.readdirSync(dir).filter(name => name.endsWith('.png') || name.endsWith('.partial'));
    assert.deepEqual(names, ['wallpaper-slot0.png']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

publishSequence('cache');
publishSequence('slot');

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-slot-'));
  const target = wallpaper.slotFile(dir, 'custom');
  const other = wallpaper.resolveWallpaperPublish({
    currentPath: OTHER,
    targetPath: target,
    ownedCachePath: '',
    cacheExists: true,
  });
  assert.equal(other.mode, 'set');
  assert.equal(other.setPath, target);
  assert.equal(other.updatePath, null);

  const missing = wallpaper.resolveWallpaperPublish({
    currentPath: CACHE,
    targetPath: target,
    ownedCachePath: CACHE,
    cacheExists: false,
  });
  assert.equal(missing.mode, 'set');
  assert.equal(missing.updatePath, null);
  assert.equal(wallpaper.isWallpaperExtensionCachePath(missing.setPath), false);

  const reuse = wallpaper.resolveWallpaperPublish({
    currentPath: CACHE,
    targetPath: target,
    ownedCachePath: CACHE,
    cacheExists: true,
  });
  assert.equal(reuse.mode, 'reuse');
  assert.equal(reuse.setPath, null);
  assert.equal(reuse.updatePath, CACHE);

  assert.throws(() => wallpaper.resolveWallpaperPublish({
    currentPath: SONOMA,
    targetPath: path.join(dir, 'wallpaper-' + Date.now() + '.png'),
    ownedCachePath: '',
    cacheExists: true,
  }));
  fs.rmSync(dir, { recursive: true, force: true });
}

assert.equal(wallpaper.isLegacyWallpaperFileName('wallpaper-slot0.png'), false);
assert.equal(wallpaper.isLegacyWallpaperFileName('wallpaper-slot1.png'), false);
assert.equal(wallpaper.isLegacyWallpaperFileName('custom-slot0.png'), false);
assert.equal(wallpaper.isLegacyWallpaperFileName('wallpaper-20261014-120301.png'), true);
assert.equal(wallpaper.isLegacyWallpaperUrl('file:///Users/x/Library/Application%20Support/WordPaper/companion/wallpaper-slot1.png'), false);
assert.equal(wallpaper.isLegacyWallpaperUrl('file:///Users/x/Library/Application%20Support/WordPaper/companion/wallpaper-20261014-120301.png'), true);
assert.equal(wallpaper.isWallpaperExtensionCachePath(SONOMA), false);
assert.equal(wallpaper.isWallpaperExtensionCachePath(CACHE), true);

const companion = fs.readFileSync(path.join(__dirname, '..', 'companion.js'), 'utf8');
assert.ok(companion.includes('function freshWallpaperFile'));
assert.ok(companion.includes('resolveWallpaperPublish'));
assert.ok(companion.includes('refusing to import a wallpaper cache file'));
assert.ok(!companion.includes('WP_OTHER'));
assert.ok(!companion.includes('options: .atomic'));
assert.ok(!companion.includes('data.write(to:'));
assert.ok(!companion.includes('wallpaperSlot'));
assert.ok(companion.includes('"wallpaper-slot0.png", "wallpaper-slot1.png"'));

console.log('wallpaper file checks ok');
