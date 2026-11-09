// Fabrique dist/wCLAUDE-darwin-arm64/wCLAUDE.app (sans signature : voir build.sh).
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const pkg = require(path.join(root, 'package.json'));
let build = '1';
try { build = execFileSync('git', ['-C', root, 'rev-list', '--count', 'HEAD']).toString().trim() || '1'; } catch { /* pas encore de commit */ }

const [appPath] = await packager({
  dir: root,
  out: path.join(root, 'dist'),
  name: 'wCLAUDE',
  executableName: 'wCLAUDE',
  platform: 'darwin',
  arch: 'arm64',
  overwrite: true,
  asar: false,
  prune: true,
  icon: path.join(root, 'assets', 'wCLAUDE.icns'),
  appBundleId: pkg.wclaude.bundleId,
  appVersion: pkg.version,
  buildVersion: build,
  appCategoryType: 'public.app-category.productivity',
  appCopyright: '© 2026 Starbudweiser',
  darwinDarkModeSupport: true,
  extendInfo: {
    CFBundleDevelopmentRegion: 'fr',
    CFBundleLocalizations: ['fr', 'en', 'es', 'it'],
    LSMinimumSystemVersion: '13.0',
    NSAppleEventsUsageDescription: 'wCLAUDE',
  },
  ignore: [/^\/dist($|\/)/, /^\/test($|\/)/, /^\/scripts($|\/)/, /^\/helper($|\/)/, /^\/assets($|\/)/, /^\/\.git/, /^\/\.claude/, /^\/[^/]+\.md$/, /^\/release\.sh$/],
});
console.log(path.join(appPath, 'wCLAUDE.app'));
