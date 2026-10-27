// Explicit test-only preload: update tests never depend on a live release.
const fs = require('fs');
const path = require('path');
require('../../lib/updater').latestRelease = async () => ({
  version: fs.readFileSync(path.resolve(__dirname, '../../VERSION'), 'utf8').trim(),
});
