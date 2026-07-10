// ====================================================================
//  粒子音乐可视化播放器 — Server v2
//  - 网易云搜索 / 歌曲URL / 封面/音频代理
//  - 扫码登录 (login_qr_*) + cookie 持久化 (./.cookie)
//  - 试听检测 (freeTrialInfo) + 全 quality 探测
//  - 所有受保护 API 都会带上已登录用户的 cookie
// ====================================================================
const fs = require('fs');
const path = require('path');
const anonymousTokenPath = path.join(require('os').tmpdir(), 'anonymous_token');

if (!fs.existsSync(anonymousTokenPath)) {
  fs.writeFileSync(anonymousTokenPath, '', 'utf8');
}

const {
  search,
  cloudsearch,
  song_detail,
  song_url,
  song_url_v1,
  login_qr_key,
  login_qr_create,
  login_qr_check,
  login_status,
  logout,
  user_account,
  user_playlist,
  comment_music,
  artist_detail,
  artist_top_song,
  artist_songs,
  like: like_song,
  likelist,
  song_like_check,
  playlist_tracks,
  playlist_track_add,
  playlist_create,
  playlist_detail,
  playlist_track_all,
  personalized,
  recommend_resource,
  recommend_songs,
  dj_detail,
  dj_program,
  dj_hot,
  dj_sublist,
  user_audio,
  dj_paygift,
  record_recent_voice,
  sati_resource_sub_list,
  lyric,
  lyric_new,
} = require('NeteaseCloudMusicApi');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const tls = require('tls');
const { once } = require('events');
const { spawn } = require('child_process');
const { fileURLToPath } = require('url');
const { analyzePodcastDjStream, analyzePodcastDjIntro } = require('./dj-analyzer');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const COOKIE_FILE = process.env.COOKIE_FILE || path.join(__dirname, '.cookie');
const QQ_COOKIE_FILE = process.env.QQ_COOKIE_FILE || path.join(__dirname, '.qq-cookie');
const KUGOU_COOKIE_FILE = process.env.KUGOU_COOKIE_FILE || path.join(__dirname, '.kugou-cookie');
const SODA_COOKIE_FILE = process.env.SODA_COOKIE_FILE || path.join(__dirname, '.soda-cookie');
const UPDATE_WORK_DIR = process.env.MINERADIO_UPDATE_DIR || path.join(__dirname, 'updates');
const UPDATE_DOWNLOAD_DIR = process.env.MINERADIO_UPDATE_DOWNLOAD_DIR || path.join(UPDATE_WORK_DIR, 'downloads');
const UPDATE_PATCH_BACKUP_DIR = process.env.MINERADIO_PATCH_BACKUP_DIR || path.join(UPDATE_WORK_DIR, 'backups', 'patches');
const BEATMAP_CACHE_DIR = process.env.MINERADIO_BEAT_CACHE_DIR || 'D:\\XKRadioCache\\beatmaps';
const APP_PACKAGE = readPackageInfo();
const APP_VERSION = process.env.MINERADIO_VERSION || APP_PACKAGE.version || '0.9.11';
const UPDATE_CONFIG = readUpdateConfig(APP_PACKAGE);
const PATCH_MAX_BYTES = 12 * 1024 * 1024;
const PATCH_ALLOWED_ROOTS = new Set(['public', 'desktop', 'build']);
const PATCH_ALLOWED_FILES = new Set(['server.js', 'dj-analyzer.js', 'package.json', 'package-lock.json']);
const UPDATE_FALLBACK_NOTES = [
  '电影镜头节奏更松',
  '音源失败自动换源',
  '右上角更新提示',
];
const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const OPEN_METEO_GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const WEATHER_IP_LOCATION_URL = 'http://ip-api.com/json/';
const WEATHER_DEFAULT_LOCATION = {
  name: '上海',
  country: 'China',
  latitude: 31.2304,
  longitude: 121.4737,
  timezone: 'Asia/Shanghai',
};

const updateDownloadJobs = new Map();

function applySystemCertificateAuthorities() {
  try {
    if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') return;
    const bundled = tls.getCACertificates('default') || [];
    const system = tls.getCACertificates('system') || [];
    if (!system.length) return;
    const seen = new Set();
    const merged = [];
    bundled.concat(system).forEach(cert => {
      if (!cert || seen.has(cert)) return;
      seen.add(cert);
      merged.push(cert);
    });
    if (merged.length > bundled.length) tls.setDefaultCACertificates(merged);
  } catch (e) {
    console.warn('[TLS] system CA merge skipped:', e.message);
  }
}

applySystemCertificateAuthorities();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

// ---------- Cookie 持久化 ----------
const COOKIE_ATTRIBUTE_NAMES = new Set(['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly']);
function collectCookiePair(picked, key, value) {
  key = String(key || '').trim();
  if (!key || COOKIE_ATTRIBUTE_NAMES.has(key.toLowerCase())) return;
  if (value === null || value === undefined) return;
  picked.set(key, String(value).trim());
}
function collectCookieInput(input, picked) {
  if (input === null || input === undefined) return;
  if (Array.isArray(input)) {
    input.forEach(item => collectCookieInput(item, picked));
    return;
  }
  if (typeof input === 'object') {
    if (input.name && Object.prototype.hasOwnProperty.call(input, 'value')) {
      collectCookiePair(picked, input.name, input.value);
      return;
    }
    Object.keys(input).forEach(key => {
      const value = input[key];
      if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')) {
        collectCookiePair(picked, key, value.value);
      } else if (typeof value !== 'object') {
        collectCookiePair(picked, key, value);
      }
    });
    return;
  }
  String(input).split(/\r?\n/).forEach(line => {
    line.split(';').forEach(part => {
      const raw = String(part || '').trim();
      const idx = raw.indexOf('=');
      if (idx <= 0) return;
      collectCookiePair(picked, raw.slice(0, idx), raw.slice(idx + 1));
    });
  });
}
function normalizeCookieHeader(input) {
  const picked = new Map();
  collectCookieInput(input, picked);
  return Array.from(picked.entries())
    .filter(([key, value]) => key && value != null && String(value) !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}
function rawCookieFallback(input) {
  if (typeof input === 'string') return input.trim();
  if (Array.isArray(input) && input.every(item => typeof item === 'string')) return input.join('; ').trim();
  return '';
}
let userCookie = '';
try { if (fs.existsSync(COOKIE_FILE)) userCookie = fs.readFileSync(COOKIE_FILE, 'utf8').trim(); }
catch (e) { userCookie = ''; }
function saveCookie(c) {
  userCookie = normalizeCookieHeader(c) || rawCookieFallback(c);
  try { fs.writeFileSync(COOKIE_FILE, userCookie); } catch (e) {}
}

let qqCookie = '';
try { if (fs.existsSync(QQ_COOKIE_FILE)) qqCookie = fs.readFileSync(QQ_COOKIE_FILE, 'utf8').trim(); }
catch (e) { qqCookie = ''; }
function saveQQCookie(c) {
  qqCookie = normalizeCookieHeader(c) || rawCookieFallback(c);
  try { fs.writeFileSync(QQ_COOKIE_FILE, qqCookie); } catch (e) {}
}

let kugouCookie = '';
try { if (fs.existsSync(KUGOU_COOKIE_FILE)) kugouCookie = fs.readFileSync(KUGOU_COOKIE_FILE, 'utf8').trim(); }
catch (e) { kugouCookie = ''; }
function saveKugouCookie(c) {
  kugouCookie = normalizeCookieHeader(c) || rawCookieFallback(c);
  try { fs.writeFileSync(KUGOU_COOKIE_FILE, kugouCookie); } catch (e) {}
}

let sodaCookie = '';
try { if (fs.existsSync(SODA_COOKIE_FILE)) sodaCookie = fs.readFileSync(SODA_COOKIE_FILE, 'utf8').trim(); }
catch (e) { sodaCookie = ''; }
function saveSodaCookie(c) {
  sodaCookie = normalizeCookieHeader(c) || rawCookieFallback(c);
  try { fs.writeFileSync(SODA_COOKIE_FILE, sodaCookie); } catch (e) {}
}

// ---------- 工具 ----------
function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}
function sendJSON(res, data, status) {
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.end(JSON.stringify(data));
}
function readPackageInfo() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}
function parseGitHubRepository(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const direct = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (direct) return { owner: direct[1], repo: direct[2].replace(/\.git$/i, '') };
  const github = raw.match(/github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[#/?].*)?$/i);
  if (github) return { owner: github[1], repo: github[2].replace(/\.git$/i, '') };
  return null;
}
function readUpdateConfig(pkg) {
  const local = (pkg && pkg.mineradio && pkg.mineradio.update) || {};
  const repoHint = process.env.MINERADIO_UPDATE_REPOSITORY
    || process.env.GITHUB_REPOSITORY
    || local.repository
    || local.github
    || (pkg && pkg.repository && (pkg.repository.url || pkg.repository))
    || '';
  const parsed = parseGitHubRepository(repoHint) || {};
  const owner = process.env.MINERADIO_UPDATE_OWNER || local.owner || parsed.owner || '';
  const repo = process.env.MINERADIO_UPDATE_REPO || local.repo || parsed.repo || '';
  return {
    provider: local.provider || 'github',
    owner,
    repo,
    configured: !!(owner && repo),
    preview: local.preview !== false,
    preferMirrors: local.preferMirrors !== false,
    mirrors: readUpdateMirrors(local),
    manifest: process.env.MINERADIO_UPDATE_MANIFEST
      || process.env.MINERADIO_UPDATE_MANIFEST_URL
      || process.env.MINERADIO_UPDATE_MANIFEST_FILE
      || '',
  };
}
function parseUpdateMirrorList(value) {
  if (Array.isArray(value)) return value;
  return String(value || '').split(/[\n,;]/);
}
function readUpdateMirrors(local) {
  const envMirrors = process.env.MINERADIO_UPDATE_MIRRORS || process.env.MINERADIO_UPDATE_MIRROR || '';
  const raw = envMirrors
    ? parseUpdateMirrorList(envMirrors)
    : parseUpdateMirrorList(local.mirrors || local.downloadMirrors || []);
  const seen = new Set();
  const mirrors = [];
  raw.forEach(item => {
    const url = String(item || '').trim();
    if (!/^https?:\/\//i.test(url)) return;
    const key = url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    mirrors.push(url);
  });
  return mirrors.slice(0, 6);
}
function normalizeDigest(value, algorithm) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const prefix = new RegExp('^' + algorithm + ':', 'i');
  return raw.replace(prefix, '').trim().replace(/^['"]|['"]$/g, '');
}
function assetDigestInfo(asset) {
  const digest = String(asset && asset.digest || '').trim();
  return {
    sha256: normalizeDigest((asset && asset.sha256) || (/^sha256:/i.test(digest) ? digest : ''), 'sha256').toLowerCase(),
    sha512: normalizeDigest((asset && asset.sha512) || (/^sha512:/i.test(digest) ? digest : ''), 'sha512'),
  };
}
function buildMirrorUrl(originalUrl, mirror) {
  const source = String(originalUrl || '').trim();
  const base = String(mirror || '').trim();
  if (!/^https?:\/\//i.test(source) || !/^https?:\/\//i.test(base)) return '';
  if (base.includes('{encodedUrl}')) return base.replace(/\{encodedUrl\}/g, encodeURIComponent(source));
  if (base.includes('{url}')) return base.replace(/\{url\}/g, source);
  return base.replace(/\/+$/, '/') + source;
}
function uniqueDownloadCandidates(urls, opts) {
  opts = opts || {};
  const directUrls = (Array.isArray(urls) ? urls : [urls])
    .map(url => String(url || '').trim())
    .filter(url => /^https?:\/\//i.test(url));
  const directSet = new Set(directUrls.map(url => url.toLowerCase()));
  const mirrors = opts.useMirrors === false ? [] : (UPDATE_CONFIG.mirrors || []);
  const mirrored = [];
  directUrls.forEach(source => {
    mirrors.forEach((mirror, index) => {
      const url = buildMirrorUrl(source, mirror);
      if (url) mirrored.push({
        url,
        label: '国内加速线路 ' + (index + 1),
        mirrored: true,
      });
    });
  });
  const direct = directUrls.map(url => ({
    url,
    label: directSet.has(url.toLowerCase()) ? 'GitHub 直连' : '下载线路',
    mirrored: false,
  }));
  const ordered = UPDATE_CONFIG.preferMirrors === false ? direct.concat(mirrored) : mirrored.concat(direct);
  const seen = new Set();
  return ordered.filter(item => {
    const key = item.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function publicDownloadUrls(candidates) {
  return (Array.isArray(candidates) ? candidates : [])
    .map(item => item && item.url)
    .filter(Boolean);
}
function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '').replace(/[+].*$/, '').replace(/-.+$/, '');
}
function compareVersions(a, b) {
  const aa = normalizeVersion(a).split('.').map(n => parseInt(n, 10) || 0);
  const bb = normalizeVersion(b).split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(aa.length, bb.length, 3);
  for (let i = 0; i < len; i++) {
    const left = aa[i] || 0;
    const right = bb[i] || 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}
function cleanReleaseLine(line) {
  return String(line || '')
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/^\s*[-*]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim();
}
function extractReleaseNotes(body) {
  const notes = [];
  String(body || '').split(/\r?\n/).forEach(line => {
    const text = cleanReleaseLine(line);
    if (!text) return;
    if (/^(what'?s changed|changes|changelog|full changelog|更新日志)$/i.test(text)) return;
    if (/^https?:\/\//i.test(text)) return;
    if (text.length > 72) return;
    notes.push(text);
  });
  return notes.slice(0, 4);
}
function pickReleaseAsset(assets) {
  const list = Array.isArray(assets) ? assets : [];
  const preferred = list.find(a => /\.(exe|msi)$/i.test(a && a.name || ''))
    || list.find(a => /\.(zip|7z)$/i.test(a && a.name || ''))
    || list[0];
  if (!preferred) return null;
  const digest = assetDigestInfo(preferred);
  const candidates = uniqueDownloadCandidates(preferred.browser_download_url || '');
  return {
    name: preferred.name || '',
    size: preferred.size || 0,
    contentType: preferred.content_type || '',
    downloadUrl: preferred.browser_download_url || '',
    downloadUrls: publicDownloadUrls(candidates),
    sha256: digest.sha256 || '',
    sha512: digest.sha512 || '',
  };
}
function patchAssetVersions(name) {
  const matches = String(name || '').match(/\d+(?:[._-]\d+){1,3}/g) || [];
  return matches.map(item => normalizeVersion(item.replace(/[._-]/g, '.'))).filter(Boolean);
}
function pickPatchAsset(assets, currentVersion, latestVersion) {
  const list = Array.isArray(assets) ? assets : [];
  const current = normalizeVersion(currentVersion || APP_VERSION);
  const latest = normalizeVersion(latestVersion || '');
  const preferred = list.find(a => {
    const name = String(a && a.name || '');
    if (!/\.(patch\.json|patch|json)$/i.test(name)) return false;
    const versions = patchAssetVersions(name);
    if (latest) return versions[0] === current && versions[versions.length - 1] === latest;
    return versions[0] === current && name.toLowerCase().includes('patch');
  }) || list.find(a => {
    const name = String(a && a.name || '');
    if (!/\.(patch\.json|patch|json)$/i.test(name)) return false;
    const versions = patchAssetVersions(name);
    return versions[0] === current && name.toLowerCase().includes('patch');
  }) || list.find(a => /\.(patch\.json|patch)$/i.test(a && a.name || ''));
  if (!preferred) return null;
  const digest = assetDigestInfo(preferred);
  const candidates = uniqueDownloadCandidates(preferred.browser_download_url || '');
  return {
    name: preferred.name || '',
    size: preferred.size || 0,
    contentType: preferred.content_type || '',
    downloadUrl: preferred.browser_download_url || '',
    downloadUrls: publicDownloadUrls(candidates),
    sha256: digest.sha256 || '',
    sha512: digest.sha512 || '',
  };
}
function updateAssetNameFromUrl(value) {
  try {
    const u = new URL(String(value || ''));
    const base = path.basename(decodeURIComponent(u.pathname || ''));
    if (base) return base;
  } catch (_) {}
  return path.basename(String(value || '').split('?')[0]) || '';
}
function normalizeManifestUpdateInfo(data) {
  data = data || {};
  const release = data.release || {};
  const asset = release.asset || data.asset || {};
  const latestVersion = normalizeVersion(
    data.latestVersion
    || data.version
    || release.version
    || release.tagName
    || release.tag_name
    || release.name
    || APP_VERSION
  ) || APP_VERSION;
  const downloadUrl = release.downloadUrl || data.downloadUrl || asset.downloadUrl || asset.browser_download_url || '';
  const patch = release.patch || data.patch || null;
  const assetUrls = [downloadUrl].concat(Array.isArray(asset.downloadUrls) ? asset.downloadUrls : []);
  const patchUrls = patch ? [patch.downloadUrl].concat(Array.isArray(patch.downloadUrls) ? patch.downloadUrls : []) : [];
  const patchInfo = patch && patch.downloadUrl ? {
    name: patch.name || updateAssetNameFromUrl(patch.downloadUrl) || `XKRadio-${APP_VERSION}→${latestVersion}.patch.json`,
    size: Number(patch.size || 0) || 0,
    contentType: patch.contentType || patch.content_type || 'application/json',
    downloadUrl: patch.downloadUrl,
    downloadUrls: publicDownloadUrls(uniqueDownloadCandidates(patchUrls)),
    from: normalizeVersion(patch.from || APP_VERSION),
    to: normalizeVersion(patch.to || latestVersion),
    sha256: normalizeDigest(patch.sha256 || '', 'sha256').toLowerCase(),
    sha512: normalizeDigest(patch.sha512 || '', 'sha512'),
  } : null;
  const notes = Array.isArray(release.notes) && release.notes.length
    ? release.notes.slice(0, 4).map(cleanReleaseLine).filter(Boolean)
    : (extractReleaseNotes(release.body || data.body).length ? extractReleaseNotes(release.body || data.body) : UPDATE_FALLBACK_NOTES);
  const assetInfo = downloadUrl ? {
    name: asset.name || updateAssetNameFromUrl(downloadUrl) || `XKRadio-${latestVersion}-Setup.exe`,
    size: Number(asset.size || 0) || 0,
    contentType: asset.contentType || asset.content_type || '',
    downloadUrl,
    downloadUrls: publicDownloadUrls(uniqueDownloadCandidates(assetUrls)),
    sha256: normalizeDigest(asset.sha256 || '', 'sha256').toLowerCase(),
    sha512: normalizeDigest(asset.sha512 || release.sha512 || data.sha512 || '', 'sha512'),
  } : null;
  return {
    configured: true,
    preview: false,
    updateAvailable: data.updateAvailable != null ? !!data.updateAvailable : compareVersions(latestVersion, APP_VERSION) > 0,
    currentVersion: APP_VERSION,
    latestVersion,
    release: {
      tagName: release.tagName || release.tag_name || data.tagName || ('v' + latestVersion),
      name: release.name || data.name || ('XK Radio v' + latestVersion),
      version: latestVersion,
      publishedAt: release.publishedAt || release.published_at || data.publishedAt || '',
      htmlUrl: release.htmlUrl || release.html_url || data.htmlUrl || '',
      downloadUrl,
      asset: assetInfo,
      patch: patchInfo,
      patchAvailable: !!(patchInfo && patchInfo.downloadUrl && compareVersions(latestVersion, APP_VERSION) > 0),
      summary: release.summary || data.summary || notes[0] || '发现新版本，建议更新。',
      notes,
    },
    source: 'manifest',
  };
}
async function readUpdateManifest(ref) {
  const value = String(ref || '').trim();
  if (!value) throw new Error('UPDATE_MANIFEST_MISSING');
  if (/^https?:\/\//i.test(value)) {
    const resp = await fetch(value, {
      headers: { 'User-Agent': `XKRadio/${APP_VERSION}` },
    });
    if (!resp.ok) throw new Error('Update manifest ' + resp.status);
    return resp.json();
  }
  const file = /^file:/i.test(value) ? fileURLToPath(value) : path.resolve(value);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
async function fetchManifestUpdateInfo(ref) {
  try {
    const data = await readUpdateManifest(ref);
    return normalizeManifestUpdateInfo(data);
  } catch (err) {
    return localUpdateFallback(err.message || 'Update manifest failed', { configured: true });
  }
}
function beatCacheRootInfo() {
  const dir = path.resolve(BEATMAP_CACHE_DIR);
  const root = path.parse(dir).root;
  const drive = root ? root.replace(/[\\\/]+$/, '').toUpperCase() : '';
  const allowed = !!root && !/^C:$/i.test(drive);
  const available = allowed && fs.existsSync(root);
  return { dir, root, drive, allowed, available };
}
function ensureBeatMapCacheDir() {
  const info = beatCacheRootInfo();
  if (!info.allowed) {
    const err = new Error('BEAT_CACHE_ON_C_DRIVE_DISABLED');
    err.code = 'BEAT_CACHE_ON_C_DRIVE_DISABLED';
    err.info = info;
    throw err;
  }
  if (!info.available) {
    const err = new Error('BEAT_CACHE_DRIVE_UNAVAILABLE');
    err.code = 'BEAT_CACHE_DRIVE_UNAVAILABLE';
    err.info = info;
    throw err;
  }
  fs.mkdirSync(info.dir, { recursive: true });
  return info.dir;
}
function safeBeatMapCacheFile(key) {
  const raw = String(key || '').trim();
  if (!raw || raw.length > 240) return null;
  const hash = crypto.createHash('sha1').update(raw).digest('hex');
  const label = raw.replace(/[^a-z0-9_.-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'beatmap';
  return path.join(ensureBeatMapCacheDir(), `${label}-${hash}.json`);
}
function compactBeatMapCachePayload(body) {
  const key = String(body && body.key || '').trim();
  const map = body && body.map;
  if (!key || !map || typeof map !== 'object') return null;
  return {
    v: 1,
    key,
    savedAt: Date.now(),
    meta: {
      provider: String(body.provider || '').slice(0, 32),
      title: String(body.title || '').slice(0, 160),
      artist: String(body.artist || '').slice(0, 160),
      mode: String(body.mode || 'mr').slice(0, 32),
    },
    map,
  };
}
function readBeatMapCache(key) {
  const file = safeBeatMapCacheFile(key);
  if (!file || !fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return raw && raw.map ? raw : null;
}
function writeBeatMapCache(body) {
  const payload = compactBeatMapCachePayload(body);
  if (!payload) return { ok: false, error: 'INVALID_BEATMAP_CACHE_PAYLOAD' };
  const file = safeBeatMapCacheFile(payload.key);
  if (!file) return { ok: false, error: 'INVALID_BEATMAP_CACHE_KEY' };
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, file);
  return { ok: true, key: payload.key, savedAt: payload.savedAt, dir: path.dirname(file) };
}
function localUpdateFallback(reason, opts) {
  opts = opts || {};
  const configured = !!(opts.configured != null ? opts.configured : false);
  return {
    configured,
    preview: UPDATE_CONFIG.preview,
    updateAvailable: false,
    currentVersion: APP_VERSION,
    latestVersion: APP_VERSION,
    release: {
      tagName: 'v' + APP_VERSION,
      name: 'XK Radio v' + APP_VERSION,
      version: APP_VERSION,
      htmlUrl: '',
      downloadUrl: '',
      summary: '当前版本，更新检测已就绪。',
      notes: UPDATE_FALLBACK_NOTES,
    },
    reason: reason || '',
  };
}
function updateError(code, message, cause) {
  const err = new Error(message || code);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}
function classifyUpdateError(err) {
  const code = String(err && err.code || '').trim();
  const message = String(err && err.message || err || '').trim();
  const detail = message || code || '未知错误';
  if (/HASH|DIGEST|CHECKSUM/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_HASH_MISMATCH', reason: '文件校验失败，可能是线路缓存异常，已拦截该安装包。', detail };
  }
  if (/SIZE_MISMATCH|content length/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_SIZE_MISMATCH', reason: '下载文件大小不一致，可能是网络中断或线路缓存不完整。', detail };
  }
  if (/AbortError|TIMEOUT|ETIMEDOUT|timeout/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_TIMEOUT', reason: '连接超时，当前网络到更新线路不稳定。', detail };
  }
  if (/ENOTFOUND|EAI_AGAIN|DNS|fetch failed|getaddrinfo/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_DNS_FAILED', reason: '域名解析失败，可能是当前网络无法连接该更新线路。', detail };
  }
  if (/ECONNRESET|ECONNREFUSED|socket|network/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_NETWORK_FAILED', reason: '网络连接被中断，已尝试切换更新线路。', detail };
  }
  const http = message.match(/\bHTTP[_\s-]?(\d{3})\b/i) || message.match(/\b(\d{3})\b/);
  if (http) {
    const status = Number(http[1]);
    if (status === 403) return { code: code || 'UPDATE_HTTP_403', reason: '更新线路返回 403，可能被限流或拦截。', detail };
    if (status === 404) return { code: code || 'UPDATE_HTTP_404', reason: '更新文件不存在，可能 release 资源还没有同步完成。', detail };
    if (status >= 500) return { code: code || 'UPDATE_HTTP_5XX', reason: '更新线路服务器异常，请稍后重试。', detail };
    return { code: code || ('UPDATE_HTTP_' + status), reason: '更新线路返回 HTTP ' + status + '。', detail };
  }
  return { code: code || 'UPDATE_FAILED', reason: '更新失败：' + detail, detail };
}
async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 12000);
  try {
    return await fetch(url, Object.assign({}, opts || {}, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}
async function fetchTextFromCandidates(candidates, timeoutMs) {
  const list = Array.isArray(candidates) && candidates.length ? candidates : [];
  const failures = [];
  for (let i = 0; i < list.length; i++) {
    const candidate = list[i];
    try {
      const resp = await fetchWithTimeout(candidate.url, {
        headers: { 'User-Agent': `XKRadio/${APP_VERSION}` },
      }, timeoutMs || 6500);
      if (!resp.ok) throw updateError('HTTP_' + resp.status, 'HTTP ' + resp.status);
      return { text: await resp.text(), candidate };
    } catch (err) {
      const info = classifyUpdateError(err);
      failures.push(candidate.label + ': ' + info.reason);
    }
  }
  throw updateError('UPDATE_ALL_LINES_FAILED', failures.join('；') || 'All update lines failed');
}
function yamlScalar(text, key) {
  const pattern = new RegExp('^\\s*' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*(.+?)\\s*$', 'm');
  const match = String(text || '').match(pattern);
  if (!match) return '';
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}
function githubReleaseDownloadUrl(version, fileName) {
  const tag = 'v' + normalizeVersion(version);
  const encodedOwner = encodeURIComponent(UPDATE_CONFIG.owner);
  const encodedRepo = encodeURIComponent(UPDATE_CONFIG.repo);
  const encodedName = String(fileName || '').split('/').map(part => encodeURIComponent(part)).join('/');
  return `https://github.com/${encodedOwner}/${encodedRepo}/releases/download/${tag}/${encodedName}`;
}
function parseLatestYmlUpdateInfo(text, reason) {
  const latestVersion = normalizeVersion(yamlScalar(text, 'version') || APP_VERSION) || APP_VERSION;
  const assetPath = yamlScalar(text, 'path') || yamlScalar(text, 'url') || `XKRadio-${latestVersion}-Setup.exe`;
  const sha512 = normalizeDigest(yamlScalar(text, 'sha512'), 'sha512');
  const size = Number(yamlScalar(text, 'size') || 0) || 0;
  const releaseDate = yamlScalar(text, 'releaseDate');
  const downloadUrl = githubReleaseDownloadUrl(latestVersion, assetPath);
  const candidates = uniqueDownloadCandidates(downloadUrl);
  const asset = {
    name: updateAssetNameFromUrl(downloadUrl) || assetPath,
    size,
    contentType: 'application/octet-stream',
    downloadUrl,
    downloadUrls: publicDownloadUrls(candidates),
    sha256: '',
    sha512,
  };
  return {
    configured: true,
    preview: false,
    updateAvailable: compareVersions(latestVersion, APP_VERSION) > 0,
    currentVersion: APP_VERSION,
    latestVersion,
    release: {
      tagName: 'v' + latestVersion,
      name: 'XK Radio v' + latestVersion,
      version: latestVersion,
      publishedAt: releaseDate,
      htmlUrl: `https://github.com/${UPDATE_CONFIG.owner}/${UPDATE_CONFIG.repo}/releases/tag/v${latestVersion}`,
      downloadUrl,
      asset,
      patch: null,
      patchAvailable: false,
      summary: '发现新版本，已启用备用更新线路。',
      notes: ['更新检测已切换到备用线路', '下载时会自动选择国内加速线路', '下载失败会显示具体原因和当前速度'],
    },
    source: 'latest-yml',
    reason: reason || '',
  };
}
async function fetchLatestYmlUpdateInfo(reason) {
  if (!UPDATE_CONFIG.configured || UPDATE_CONFIG.provider !== 'github') throw updateError('UPDATE_REPOSITORY_NOT_CONFIGURED');
  const latestYmlUrl = `https://github.com/${encodeURIComponent(UPDATE_CONFIG.owner)}/${encodeURIComponent(UPDATE_CONFIG.repo)}/releases/latest/download/latest.yml`;
  const candidates = uniqueDownloadCandidates(latestYmlUrl);
  const result = await fetchTextFromCandidates(candidates, 6500);
  return parseLatestYmlUpdateInfo(result.text, reason);
}
async function fetchLatestUpdateInfo() {
  if (UPDATE_CONFIG.manifest) return fetchManifestUpdateInfo(UPDATE_CONFIG.manifest);
  if (!UPDATE_CONFIG.configured || UPDATE_CONFIG.provider !== 'github') return localUpdateFallback();
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(UPDATE_CONFIG.owner)}/${encodeURIComponent(UPDATE_CONFIG.repo)}/releases/latest`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8500);
  try {
    const resp = await fetch(apiUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': `XKRadio/${APP_VERSION}`,
        'Accept': 'application/vnd.github+json',
      },
    });
    if (!resp.ok) {
      try { return await fetchLatestYmlUpdateInfo('GitHub Releases ' + resp.status); }
      catch (_) { return localUpdateFallback('GitHub Releases ' + resp.status, { configured: true }); }
    }
    const data = await resp.json();
    const latestVersion = normalizeVersion(data.tag_name || data.name || APP_VERSION) || APP_VERSION;
    const asset = pickReleaseAsset(data.assets);
    const patch = pickPatchAsset(data.assets, APP_VERSION, latestVersion);
    const notes = extractReleaseNotes(data.body).length ? extractReleaseNotes(data.body) : UPDATE_FALLBACK_NOTES;
    return {
      configured: true,
      preview: false,
      updateAvailable: compareVersions(latestVersion, APP_VERSION) > 0,
      currentVersion: APP_VERSION,
      latestVersion,
      release: {
        tagName: data.tag_name || ('v' + latestVersion),
        name: data.name || ('XK Radio v' + latestVersion),
        version: latestVersion,
        publishedAt: data.published_at || '',
        htmlUrl: data.html_url || '',
        downloadUrl: asset ? asset.downloadUrl : '',
        asset,
        patch,
        patchAvailable: !!(patch && patch.downloadUrl && compareVersions(latestVersion, APP_VERSION) > 0),
        summary: notes[0] || '发现新版本，建议更新。',
        notes,
      },
    };
  } catch (err) {
    const reason = err && err.message || 'Update check failed';
    try { return await fetchLatestYmlUpdateInfo(reason); }
    catch (fallbackErr) { return localUpdateFallback((fallbackErr && fallbackErr.message) || reason, { configured: true }); }
  } finally {
    clearTimeout(timer);
  }
}
function safeUpdateFileName(name, version) {
  const raw = String(name || '').trim() || `XKRadio-${version || APP_VERSION}.exe`;
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return cleaned || `XKRadio-${version || APP_VERSION}.exe`;
}
function publicUpdateJob(job) {
  if (!job) return { ok: false, error: 'UPDATE_JOB_NOT_FOUND' };
  return {
    ok: job.status !== 'error',
    id: job.id,
    status: job.status,
    progress: job.progress || 0,
    received: job.received || 0,
    total: job.total || 0,
    speedBps: job.speedBps || 0,
    etaSeconds: job.etaSeconds || 0,
    sourceLabel: job.sourceLabel || '',
    attempt: job.attempt || 0,
    attempts: job.attempts || 0,
    mode: job.mode || 'installer',
    message: job.message || '',
    restartRequired: !!job.restartRequired,
    cached: !!job.cached,
    fileName: job.fileName || '',
    filePath: job.status === 'ready' ? job.filePath : '',
    version: job.version || '',
    releaseUrl: job.releaseUrl || '',
    error: job.error || '',
    errorReason: job.errorReason || '',
    errorDetail: job.errorDetail || '',
    failedAttempts: Array.isArray(job.failedAttempts) ? job.failedAttempts.slice(0, 6) : [],
    pausable: job.mode === 'installer' && (job.status === 'queued' || job.status === 'downloading'),
    resumable: job.mode === 'installer' && job.status === 'paused',
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
function activeUpdateJobFor(version) {
  const jobs = Array.from(updateDownloadJobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return jobs.find(job => job.version === version && (job.status === 'queued' || job.status === 'downloading' || job.status === 'paused' || job.status === 'ready'));
}
function trimUpdateJobs() {
  const jobs = Array.from(updateDownloadJobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  jobs.slice(8).forEach(job => updateDownloadJobs.delete(job.id));
}
async function downloadUpdateAsset(job) {
  const tmpPath = job.filePath + '.download';
  try {
    fs.mkdirSync(UPDATE_DOWNLOAD_DIR, { recursive: true });
    job.status = 'downloading';
    job.updatedAt = Date.now();

    const resp = await fetch(job.downloadUrl, {
      headers: {
        'User-Agent': `XKRadio/${APP_VERSION}`,
      },
    });
    if (!resp.ok) throw new Error('Download failed ' + resp.status);

    const totalHeader = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
    job.total = totalHeader || job.total || 0;
    job.received = 0;
    job.progress = 0;
    job.speedBps = 0;
    job.etaSeconds = 0;
    job.message = job.total ? '正在下载完整安装包' : '正在下载完整安装包，等待服务器返回大小';
    job.updatedAt = Date.now();
    let speedWindowAt = Date.now();
    let speedWindowBytes = 0;

    const writer = fs.createWriteStream(tmpPath);
    const reader = resp.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const buf = Buffer.from(chunk.value);
        job.received += buf.length;
        speedWindowBytes += buf.length;
        const now = Date.now();
        if (now - speedWindowAt >= 900) {
          job.speedBps = Math.round(speedWindowBytes / Math.max(0.001, (now - speedWindowAt) / 1000));
          speedWindowAt = now;
          speedWindowBytes = 0;
        }
        if (job.total > 0) {
          job.progress = Math.max(1, Math.min(99, Math.round((job.received / job.total) * 100)));
          job.etaSeconds = job.speedBps > 0 ? Math.max(0, Math.round((job.total - job.received) / job.speedBps)) : 0;
        } else {
          const kb = Math.max(1, job.received / 1024);
          job.progress = Math.max(1, Math.min(88, Math.round(Math.log10(kb + 1) * 24)));
        }
        job.message = job.total > 0 ? '正在下载完整安装包' : '正在下载完整安装包，服务器未提供总大小';
        job.updatedAt = Date.now();
        if (!writer.write(buf)) await once(writer, 'drain');
      }
    } finally {
      writer.end();
      await once(writer, 'finish').catch(() => {});
    }

    if (fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath);
    fs.renameSync(tmpPath, job.filePath);
    job.status = 'ready';
    job.progress = 100;
    job.message = '安装包已下载';
    job.updatedAt = Date.now();
  } catch (e) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
    job.status = 'error';
    job.error = e.message || 'UPDATE_DOWNLOAD_FAILED';
    job.updatedAt = Date.now();
  }
}
function sha512Base64(buffer) {
  return crypto.createHash('sha512').update(buffer).digest('base64');
}
function sha512Hex(buffer) {
  return crypto.createHash('sha512').update(buffer).digest('hex');
}
function verifyUpdateBuffer(buffer, job) {
  const expectedSize = Number(job.expectedSize || job.total || 0) || 0;
  if (expectedSize > 0 && buffer.length !== expectedSize) {
    throw updateError('UPDATE_SIZE_MISMATCH', `Expected ${expectedSize} bytes, got ${buffer.length}`);
  }
  const expectedSha256 = normalizeDigest(job.sha256 || '', 'sha256').toLowerCase();
  if (expectedSha256 && sha256Hex(buffer) !== expectedSha256) {
    throw updateError('UPDATE_SHA256_MISMATCH', 'Downloaded sha256 mismatch');
  }
  const expectedSha512 = normalizeDigest(job.sha512 || '', 'sha512');
  if (expectedSha512) {
    const actualBase64 = sha512Base64(buffer);
    const actualHex = sha512Hex(buffer).toLowerCase();
    if (actualBase64 !== expectedSha512 && actualHex !== expectedSha512.toLowerCase()) {
      throw updateError('UPDATE_SHA512_MISMATCH', 'Downloaded sha512 mismatch');
    }
  }
  job.running = false;
}
function verifyUpdateFile(filePath, job) {
  verifyUpdateBuffer(fs.readFileSync(filePath), job);
}
function moveInvalidUpdateFile(filePath, reason) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return;
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);
    const invalidPath = path.join(dir, `${base}.invalid-${Date.now()}${ext || '.bin'}`);
    fs.renameSync(filePath, invalidPath);
    console.warn('[UpdateDownload] cached installer moved aside:', reason || 'invalid', invalidPath);
  } catch (e) {
    console.warn('[UpdateDownload] failed to move invalid cached installer:', e.message);
  }
}
function reuseVerifiedInstallerJob(opts) {
  if (!opts || !opts.filePath || !fs.existsSync(opts.filePath)) return null;
  if (!opts.expectedSize && !opts.sha256 && !opts.sha512) return null;
  const now = Date.now();
  const stat = fs.statSync(opts.filePath);
  const job = {
    id: 'cached-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    status: 'ready',
    progress: 100,
    received: stat.size || 0,
    total: opts.expectedSize || stat.size || 0,
    speedBps: 0,
    etaSeconds: 0,
    sourceLabel: '本地缓存',
    attempt: 0,
    attempts: opts.attempts || 0,
    mode: 'installer',
    message: '安装包已下载，可直接打开安装',
    fileName: opts.fileName || path.basename(opts.filePath),
    filePath: opts.filePath,
    version: opts.version || '',
    downloadUrl: opts.downloadUrl || '',
    downloadCandidates: opts.downloadCandidates || [],
    expectedSize: opts.expectedSize || 0,
    sha256: opts.sha256 || '',
    sha512: opts.sha512 || '',
    releaseUrl: opts.releaseUrl || '',
    failedAttempts: [],
    cached: true,
    createdAt: now,
    updatedAt: now,
    error: '',
  };
  try {
    verifyUpdateFile(opts.filePath, job);
    updateDownloadJobs.set(job.id, job);
    trimUpdateJobs();
    return job;
  } catch (err) {
    moveInvalidUpdateFile(opts.filePath, (err && err.message) || 'cache verification failed');
    return null;
  }
}
function setUpdateJobError(job, err, fallbackMessage) {
  const info = classifyUpdateError(err);
  job.status = 'error';
  job.error = info.code;
  job.errorReason = info.reason;
  job.errorDetail = info.detail;
  job.message = fallbackMessage || info.reason;
  job.updatedAt = Date.now();
}
function prepareUpdateJobAttempt(job, candidate, index, total) {
  job.status = 'downloading';
  job.sourceLabel = candidate.label || '下载线路';
  job.attempt = index + 1;
  job.attempts = total;
  job.received = 0;
  job.speedBps = 0;
  job.etaSeconds = 0;
  job.error = '';
  job.errorReason = '';
  job.errorDetail = '';
  job.updatedAt = Date.now();
}
function ensureMirrorCanBeVerified(job, candidate) {
  if (!candidate || !candidate.mirrored) return;
  if (job.sha256 || job.sha512) return;
  throw updateError('MIRROR_HASH_MISSING', 'Mirror download skipped because no digest is available');
}
async function downloadUpdateAssetWithMirrors(job) {
  const tmpPath = job.filePath + '.download';
  const candidates = Array.isArray(job.downloadCandidates) && job.downloadCandidates.length
    ? job.downloadCandidates
    : uniqueDownloadCandidates(job.downloadUrl || '');
  const failures = [];
  if (job.running) return;
  job.running = true;
  job.pauseRequested = false;
  fs.mkdirSync(UPDATE_DOWNLOAD_DIR, { recursive: true });
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
      ensureMirrorCanBeVerified(job, candidate);
      prepareUpdateJobAttempt(job, candidate, i, candidates.length);
      job.message = job.total ? '正在下载完整安装包' : '正在下载完整安装包，等待服务器返回大小';

      const controller = new AbortController();
      job.abortController = controller;
      const timeout = setTimeout(() => controller.abort(), 14000);
      let resp;
      try {
        resp = await fetch(candidate.url, {
          signal: controller.signal,
          headers: { 'User-Agent': `XKRadio/${APP_VERSION}` },
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!resp.ok) throw updateError('HTTP_' + resp.status, 'HTTP ' + resp.status);

      const totalHeader = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
      job.total = totalHeader || job.expectedSize || job.total || 0;
      job.progress = 0;
      job.updatedAt = Date.now();
      let speedWindowAt = Date.now();
      let speedWindowBytes = 0;

      const writer = fs.createWriteStream(tmpPath);
      const reader = resp.body.getReader();
      try {
        while (true) {
          if (job.pauseRequested) throw updateError('UPDATE_PAUSED', 'Update download paused');
          const chunk = await reader.read();
          if (chunk.done) break;
          if (job.pauseRequested) throw updateError('UPDATE_PAUSED', 'Update download paused');
          const buf = Buffer.from(chunk.value);
          job.received += buf.length;
          speedWindowBytes += buf.length;
          const now = Date.now();
          if (now - speedWindowAt >= 900) {
            job.speedBps = Math.round(speedWindowBytes / Math.max(0.001, (now - speedWindowAt) / 1000));
            speedWindowAt = now;
            speedWindowBytes = 0;
          }
          if (job.total > 0) {
            job.progress = Math.max(1, Math.min(99, Math.round((job.received / job.total) * 100)));
            job.etaSeconds = job.speedBps > 0 ? Math.max(0, Math.round((job.total - job.received) / job.speedBps)) : 0;
          } else {
            const kb = Math.max(1, job.received / 1024);
            job.progress = Math.max(1, Math.min(88, Math.round(Math.log10(kb + 1) * 24)));
          }
          job.message = job.total > 0 ? '正在下载完整安装包' : '正在下载完整安装包，服务器未提供总大小';
          job.updatedAt = Date.now();
          if (!writer.write(buf)) await once(writer, 'drain');
        }
      } finally {
        writer.end();
        await once(writer, 'finish').catch(() => {});
      }

      verifyUpdateFile(tmpPath, job);
      if (fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath);
      fs.renameSync(tmpPath, job.filePath);
      job.status = 'ready';
      job.progress = 100;
      job.etaSeconds = 0;
      job.message = '安装包已下载';
      job.updatedAt = Date.now();
      job.running = false;
      return;
    } catch (err) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
      if (job.pauseRequested) {
        job.status = 'paused';
        job.speedBps = 0;
        job.etaSeconds = 0;
        job.message = '下载已暂停';
        job.updatedAt = Date.now();
        job.running = false;
        if (job.resumeAfterPause) {
          job.resumeAfterPause = false;
          resumeUpdateDownloadJob(job.id);
        }
        return;
      }
      const info = classifyUpdateError(err);
      failures.push({ source: candidate.label || '下载线路', reason: info.reason, detail: info.detail });
      job.failedAttempts = failures.slice(-6);
      job.message = i < candidates.length - 1 ? ((candidate.label || '当前线路') + '失败，正在切换线路') : info.reason;
      job.updatedAt = Date.now();
      if (i >= candidates.length - 1) setUpdateJobError(job, err, '下载失败：' + info.reason);
    }
  }
}
function pauseUpdateDownloadJob(id) {
  const job = updateDownloadJobs.get(id || '');
  if (!job) return { ok: false, error: 'UPDATE_JOB_NOT_FOUND' };
  if (job.mode !== 'installer') return { ok: false, error: 'UPDATE_PAUSE_UNSUPPORTED' };
  if (job.status === 'paused') return publicUpdateJob(job);
  if (job.status !== 'queued' && job.status !== 'downloading') return { ok: false, error: 'UPDATE_NOT_PAUSABLE' };
  job.pauseRequested = true;
  job.status = 'paused';
  job.speedBps = 0;
  job.etaSeconds = 0;
  job.message = '下载已暂停';
  job.updatedAt = Date.now();
  try { if (job.abortController) job.abortController.abort(); } catch (_) {}
  return publicUpdateJob(job);
}
function resumeUpdateDownloadJob(id) {
  const job = updateDownloadJobs.get(id || '');
  if (!job) return { ok: false, error: 'UPDATE_JOB_NOT_FOUND' };
  if (job.mode !== 'installer') return { ok: false, error: 'UPDATE_RESUME_UNSUPPORTED' };
  if (job.status !== 'paused') return publicUpdateJob(job);
  if (job.running) {
    job.resumeAfterPause = true;
    job.message = '正在准备继续下载';
    job.updatedAt = Date.now();
    return publicUpdateJob(job);
  }
  job.pauseRequested = false;
  job.status = 'queued';
  job.received = 0;
  job.progress = 0;
  job.speedBps = 0;
  job.etaSeconds = 0;
  job.message = '正在继续下载完整安装包';
  job.updatedAt = Date.now();
  setTimeout(() => downloadUpdateAssetWithMirrors(job), 80);
  return publicUpdateJob(job);
}
function startUpdateDownloadJob(info) {
  const release = info && info.release ? info.release : {};
  const asset = release.asset || {};
  const downloadUrl = release.downloadUrl || asset.downloadUrl || '';
  if (!info || !info.configured) return { ok: false, error: 'UPDATE_REPOSITORY_NOT_CONFIGURED' };
  if (!info.updateAvailable) return { ok: false, error: 'NO_UPDATE_AVAILABLE' };
  if (!/^https?:\/\//i.test(downloadUrl)) return { ok: false, error: 'UPDATE_ASSET_MISSING' };

  const version = info.latestVersion || release.version || '';
  const existing = activeUpdateJobFor(version);
  if (existing) return publicUpdateJob(existing);

  const fileName = safeUpdateFileName(asset.name || '', version);
  const filePath = path.join(UPDATE_DOWNLOAD_DIR, fileName);
  const downloadCandidates = uniqueDownloadCandidates([downloadUrl].concat(Array.isArray(asset.downloadUrls) ? asset.downloadUrls : []));
  const expectedSize = asset.size || 0;
  const sha256 = normalizeDigest(asset.sha256 || '', 'sha256').toLowerCase();
  const sha512 = normalizeDigest(asset.sha512 || '', 'sha512');
  const cached = reuseVerifiedInstallerJob({
    fileName,
    filePath,
    version,
    downloadUrl,
    downloadCandidates,
    expectedSize,
    sha256,
    sha512,
    releaseUrl: release.htmlUrl || '',
    attempts: downloadCandidates.length,
  });
  if (cached) return publicUpdateJob(cached);

  const now = Date.now();
  const job = {
    id: now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    status: 'queued',
    progress: 0,
    received: 0,
    total: expectedSize,
    mode: 'installer',
    fileName,
    filePath,
    version,
    downloadUrl,
    downloadCandidates,
    expectedSize,
    sha256,
    sha512,
    releaseUrl: release.htmlUrl || '',
    sourceLabel: '',
    attempt: 0,
    attempts: downloadCandidates.length,
    failedAttempts: [],
    createdAt: now,
    updatedAt: now,
    error: '',
  };
  updateDownloadJobs.set(job.id, job);
  trimUpdateJobs();
  downloadUpdateAssetWithMirrors(job);
  return publicUpdateJob(job);
}
function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
function safePatchRelativePath(value) {
  const rel = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!rel || rel.includes('\0')) return '';
  const parts = rel.split('/').filter(Boolean);
  if (!parts.length || parts.some(part => part === '..' || part === '.')) return '';
  const root = parts[0];
  if (PATCH_ALLOWED_FILES.has(rel)) return rel;
  if (!PATCH_ALLOWED_ROOTS.has(root)) return '';
  if (/\.(exe|dll|node|msi|bat|cmd|ps1|pfx|pem|key)$/i.test(rel)) return '';
  return parts.join('/');
}
function patchTargetPath(rel) {
  const safeRel = safePatchRelativePath(rel);
  if (!safeRel) return null;
  const target = path.resolve(__dirname, safeRel);
  const root = path.resolve(__dirname);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}
function decodePatchFile(file) {
  if (!file || typeof file !== 'object') return null;
  if (typeof file.contentBase64 === 'string') return Buffer.from(file.contentBase64, 'base64');
  if (typeof file.content === 'string') return Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
  return null;
}
function backupPatchTarget(job, rel, target) {
  if (!fs.existsSync(target)) return;
  const backup = path.join(UPDATE_PATCH_BACKUP_DIR, job.id, rel);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(target, backup);
}
function writePatchFile(job, file) {
  const rel = safePatchRelativePath(file.path || file.name);
  const target = rel ? patchTargetPath(rel) : null;
  const content = decodePatchFile(file);
  if (!rel || !target || !content) throw new Error('INVALID_PATCH_FILE');
  if (content.length > PATCH_MAX_BYTES) throw new Error('PATCH_FILE_TOO_LARGE');
  const expected = String(file.sha256 || '').trim().toLowerCase();
  const actual = sha256Hex(content);
  if (expected && expected !== actual) throw new Error('PATCH_HASH_MISMATCH:' + rel);
  backupPatchTarget(job, rel, target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.mineradio-patch';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
  if (expected && sha256Hex(fs.readFileSync(target)) !== expected) throw new Error('PATCH_WRITE_VERIFY_FAILED:' + rel);
  return rel;
}
function normalizePatchPayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('INVALID_PATCH_PAYLOAD');
  const type = String(payload.type || payload.kind || '');
  if (type && type !== 'mineradio-resource-patch') throw new Error('UNSUPPORTED_PATCH_TYPE');
  const from = normalizeVersion(payload.from || payload.baseVersion || '');
  const to = normalizeVersion(payload.to || payload.version || payload.targetVersion || '');
  const files = Array.isArray(payload.files) ? payload.files : [];
  if (!from || compareVersions(from, APP_VERSION) !== 0) throw new Error('PATCH_VERSION_MISMATCH');
  if (!to || compareVersions(to, APP_VERSION) <= 0) throw new Error('PATCH_TARGET_VERSION_INVALID');
  if (!files.length) throw new Error('PATCH_EMPTY');
  if (files.length > 40) throw new Error('PATCH_TOO_MANY_FILES');
  return { from, to, files, restartRequired: payload.restartRequired !== false };
}
async function downloadAndApplyPatch(job) {
  const chunks = [];
  try {
    fs.mkdirSync(UPDATE_DOWNLOAD_DIR, { recursive: true });
    job.status = 'downloading';
    job.mode = 'patch';
    job.message = '正在下载快速补丁';
    job.updatedAt = Date.now();

    const resp = await fetch(job.downloadUrl, {
      headers: { 'User-Agent': `XKRadio/${APP_VERSION}` },
    });
    if (!resp.ok) throw new Error('Patch download failed ' + resp.status);

    job.total = parseInt(resp.headers.get('content-length') || '0', 10) || job.total || 0;
    job.received = 0;
    const reader = resp.body.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const buf = Buffer.from(chunk.value);
      job.received += buf.length;
      if (job.received > PATCH_MAX_BYTES) throw new Error('PATCH_TOO_LARGE');
      chunks.push(buf);
      job.progress = job.total > 0
        ? Math.max(1, Math.min(84, Math.round((job.received / job.total) * 84)))
        : Math.max(1, Math.min(76, Math.round(Math.log10(job.received / 1024 + 1) * 24)));
      job.updatedAt = Date.now();
    }

    const raw = Buffer.concat(chunks);
    const expectedPatchHash = String(job.sha256 || '').trim().toLowerCase();
    if (expectedPatchHash && sha256Hex(raw) !== expectedPatchHash) throw new Error('PATCH_PACKAGE_HASH_MISMATCH');
    const patch = normalizePatchPayload(JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')));
    job.version = patch.to;
    job.message = '正在应用快速补丁';
    job.progress = 88;
    job.updatedAt = Date.now();
    const changed = [];
    patch.files.forEach(file => changed.push(writePatchFile(job, file)));
    job.changedFiles = changed;
    job.status = 'ready';
    job.progress = 100;
    job.restartRequired = patch.restartRequired;
    job.message = patch.restartRequired ? '快速补丁已应用，重启后生效' : '快速补丁已应用';
    job.updatedAt = Date.now();
  } catch (e) {
    job.status = 'error';
    job.error = e.message || 'PATCH_APPLY_FAILED';
    job.message = '快速补丁失败，可改用完整安装包';
    job.updatedAt = Date.now();
  }
}
async function downloadPatchBufferFromCandidate(job, candidate, index, total) {
  ensureMirrorCanBeVerified(job, candidate);
  prepareUpdateJobAttempt(job, candidate, index, total);
  job.mode = 'patch';
  job.message = '正在下载快速补丁';
  job.progress = 0;
  job.updatedAt = Date.now();

  const resp = await fetchWithTimeout(candidate.url, {
    headers: { 'User-Agent': `XKRadio/${APP_VERSION}` },
  }, 12000);
  if (!resp.ok) throw updateError('HTTP_' + resp.status, 'HTTP ' + resp.status);

  job.total = parseInt(resp.headers.get('content-length') || '0', 10) || job.expectedSize || job.total || 0;
  job.received = 0;
  const chunks = [];
  const reader = resp.body.getReader();
  let speedWindowAt = Date.now();
  let speedWindowBytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const buf = Buffer.from(chunk.value);
    job.received += buf.length;
    speedWindowBytes += buf.length;
    if (job.received > PATCH_MAX_BYTES) throw updateError('PATCH_TOO_LARGE', 'Patch package is too large');
    chunks.push(buf);
    const now = Date.now();
    if (now - speedWindowAt >= 700) {
      job.speedBps = Math.round(speedWindowBytes / Math.max(0.001, (now - speedWindowAt) / 1000));
      speedWindowAt = now;
      speedWindowBytes = 0;
    }
    job.progress = job.total > 0
      ? Math.max(1, Math.min(84, Math.round((job.received / job.total) * 84)))
      : Math.max(1, Math.min(76, Math.round(Math.log10(job.received / 1024 + 1) * 24)));
    job.etaSeconds = job.total > 0 && job.speedBps > 0 ? Math.max(0, Math.round((job.total - job.received) / job.speedBps)) : 0;
    job.updatedAt = Date.now();
  }
  const raw = Buffer.concat(chunks);
  verifyUpdateBuffer(raw, job);
  return raw;
}
async function downloadAndApplyPatchWithMirrors(job) {
  const candidates = Array.isArray(job.downloadCandidates) && job.downloadCandidates.length
    ? job.downloadCandidates
    : uniqueDownloadCandidates(job.downloadUrl || '');
  const failures = [];
  fs.mkdirSync(UPDATE_DOWNLOAD_DIR, { recursive: true });
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      const raw = await downloadPatchBufferFromCandidate(job, candidate, i, candidates.length);
      const patch = normalizePatchPayload(JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')));
      job.version = patch.to;
      job.message = '正在应用快速补丁';
      job.progress = 88;
      job.etaSeconds = 0;
      job.updatedAt = Date.now();
      const changed = [];
      patch.files.forEach(file => changed.push(writePatchFile(job, file)));
      job.changedFiles = changed;
      job.status = 'ready';
      job.progress = 100;
      job.restartRequired = patch.restartRequired;
      job.message = patch.restartRequired ? '快速补丁已应用，重启后生效' : '快速补丁已应用';
      job.updatedAt = Date.now();
      return;
    } catch (err) {
      const info = classifyUpdateError(err);
      failures.push({ source: candidate.label || '下载线路', reason: info.reason, detail: info.detail });
      job.failedAttempts = failures.slice(-6);
      job.message = i < candidates.length - 1 ? ((candidate.label || '当前线路') + '失败，正在切换线路') : info.reason;
      job.updatedAt = Date.now();
      if (i >= candidates.length - 1) setUpdateJobError(job, err, '快速补丁失败：' + info.reason);
    }
  }
}
function startUpdatePatchJob(info) {
  const release = info && info.release ? info.release : {};
  const patch = release.patch || {};
  const downloadUrl = patch.downloadUrl || '';
  if (!info || !info.configured) return { ok: false, error: 'UPDATE_REPOSITORY_NOT_CONFIGURED' };
  if (!info.updateAvailable) return { ok: false, error: 'NO_UPDATE_AVAILABLE' };
  if (!release.patchAvailable || !/^https?:\/\//i.test(downloadUrl)) return { ok: false, error: 'PATCH_ASSET_MISSING' };

  const version = info.latestVersion || release.version || patch.to || '';
  const existing = Array.from(updateDownloadJobs.values())
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .find(job => job.mode === 'patch' && job.version === version && (job.status === 'queued' || job.status === 'downloading' || job.status === 'ready'));
  if (existing) return publicUpdateJob(existing);

  const now = Date.now();
  const downloadCandidates = uniqueDownloadCandidates([downloadUrl].concat(Array.isArray(patch.downloadUrls) ? patch.downloadUrls : []));
  const job = {
    id: 'patch-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    status: 'queued',
    progress: 0,
    received: 0,
    total: patch.size || 0,
    mode: 'patch',
    fileName: patch.name || safeUpdateFileName('', version).replace(/\.exe$/i, '.patch.json'),
    filePath: '',
    version,
    downloadUrl,
    downloadCandidates,
    releaseUrl: release.htmlUrl || '',
    expectedSize: patch.size || 0,
    sha256: normalizeDigest(patch.sha256 || '', 'sha256').toLowerCase(),
    sha512: normalizeDigest(patch.sha512 || '', 'sha512'),
    restartRequired: true,
    sourceLabel: '',
    attempt: 0,
    attempts: downloadCandidates.length,
    failedAttempts: [],
    message: '等待下载快速补丁',
    createdAt: now,
    updatedAt: now,
    error: '',
  };
  updateDownloadJobs.set(job.id, job);
  trimUpdateJobs();
  downloadAndApplyPatchWithMirrors(job);
  return publicUpdateJob(job);
}
function readRequestBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 8 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); }
      catch (e) {
        const params = new URLSearchParams(raw);
        const out = {};
        params.forEach((v, k) => { out[k] = v; });
        resolve(out);
      }
    });
    req.on('error', () => resolve({}));
  });
}
function normalizeApiCode(payload) {
  const body = payload && (payload.body || payload);
  return Number((body && body.code) || (body && body.body && body.body.code) || (payload && payload.status) || 0);
}
function normalizeApiMessage(payload) {
  const body = payload && (payload.body || payload);
  return (body && (body.message || body.msg || body.error)) || (body && body.body && (body.body.message || body.body.msg || body.body.error)) || '';
}
function parseCookieString(cookieText) {
  const out = {};
  String(cookieText || '').split(';').forEach(part => {
    const raw = String(part || '').trim();
    if (!raw) return;
    const idx = raw.indexOf('=');
    if (idx <= 0) return;
    const key = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (key) out[key] = value;
  });
  return out;
}
function serializeCookieObject(obj) {
  return Object.keys(obj || {})
    .filter(k => obj[k] != null && String(obj[k]) !== '')
    .map(k => k + '=' + String(obj[k]))
    .join('; ');
}
function qqCookieObject() {
  return parseCookieString(qqCookie);
}
function normalizeQQUin(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.replace(/^0+/, '') || digits;
}
function qqCookieUin(obj) {
  obj = obj || qqCookieObject();
  const raw = Number(obj.login_type) === 2 ? (obj.wxuin || obj.uin || obj.p_uin) : (obj.uin || obj.qqmusic_uin || obj.wxuin || obj.p_uin);
  return normalizeQQUin(raw);
}
function qqCookieMusicKey(obj) {
  obj = obj || qqCookieObject();
  return obj.qm_keyst || obj.qqmusic_key || obj.music_key || obj.p_skey || obj.skey ||
    obj.psrf_qqaccess_token || obj.psrf_qqrefresh_token || obj.wxrefresh_token || obj.wxskey || '';
}
function qqCookiePlaybackKey(obj) {
  obj = obj || qqCookieObject();
  return obj.qm_keyst || obj.qqmusic_key || obj.music_key || obj.wxskey || '';
}
function decodeQQCookieValue(value) {
  try { return decodeURIComponent(String(value || '').replace(/\+/g, '%20')).trim(); }
  catch (e) { return String(value || '').trim(); }
}
function qqCookieNickname(obj, uin) {
  obj = obj || qqCookieObject();
  uin = normalizeQQUin(uin || qqCookieUin(obj));
  const padded = uin ? '0' + uin : '';
  const keys = [
    uin && ('ptnick_' + uin),
    padded && ('ptnick_' + padded),
    'ptnick',
    'nick',
    'nickname',
    'qq_nickname'
  ].filter(Boolean);
  for (const key of keys) {
    if (obj[key]) {
      const nick = decodeQQCookieValue(obj[key]);
      if (nick) return nick;
    }
  }
  const ptnickKey = Object.keys(obj).find(key => /^ptnick_/i.test(key) && obj[key]);
  return ptnickKey ? decodeQQCookieValue(obj[ptnickKey]) : '';
}
function qqCookieAvatar(obj, uin) {
  obj = obj || qqCookieObject();
  const direct = obj.qqmusic_avatar || obj.avatar || obj.avatarUrl || obj.headpic || '';
  if (direct) return decodeQQCookieValue(direct);
  uin = normalizeQQUin(uin || qqCookieUin(obj));
  return uin ? `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uin)}&s=100` : '';
}
function normalizeQQCookieInput(cookieText) {
  const obj = parseCookieString(cookieText);
  if (Number(obj.login_type) === 2 && obj.wxuin && !obj.uin) obj.uin = obj.wxuin;
  if (!obj.uin && (obj.qqmusic_uin || obj.p_uin)) obj.uin = obj.qqmusic_uin || obj.p_uin;
  if (obj.uin) obj.uin = normalizeQQUin(obj.uin);
  return serializeCookieObject(obj);
}
function decodeKugouCookieValue(value) {
  let text = String(value || '').trim();
  text = text.replace(/%u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  for (let i = 0; i < 2; i++) {
    try {
      const decoded = decodeURIComponent(text.replace(/\+/g, '%20')).trim();
      if (!decoded || decoded === text) break;
      text = decoded;
    } catch (e) {
      break;
    }
  }
  return text;
}
function expandKugouCookieObject(input) {
  const out = { ...(input || {}) };
  Object.keys(input || {}).forEach(key => {
    const decoded = decodeKugouCookieValue(input[key]);
    if (!decoded || decoded.indexOf('=') < 0) return;
    decoded.split(/[&|]/).forEach(part => {
      const idx = part.indexOf('=');
      if (idx <= 0) return;
      const nestedKey = part.slice(0, idx).trim();
      const nestedValue = part.slice(idx + 1).trim();
      if (nestedKey && !out[nestedKey]) out[nestedKey] = nestedValue;
    });
  });
  return out;
}
function kugouCookieObject() {
  return expandKugouCookieObject(parseCookieString(kugouCookie));
}
function kugouCookieValue(obj, names) {
  obj = obj || kugouCookieObject();
  const lower = {};
  Object.keys(obj || {}).forEach(key => { lower[key.toLowerCase()] = obj[key]; });
  for (const name of names) {
    const direct = obj[name];
    const folded = lower[String(name).toLowerCase()];
    const value = direct != null ? direct : folded;
    if (value != null && String(value).trim() !== '') return decodeKugouCookieValue(value);
  }
  return '';
}
function kugouCookieUserId(obj) {
  const raw = kugouCookieValue(obj, ['UserID', 'userid', 'userId', 'KugooID', 'uid', 'kg_uid']);
  return String(raw || '').replace(/[^\w-]/g, '');
}
function kugouCookieToken(obj) {
  return kugouCookieValue(obj, ['token', 't', 'Token', 'kg_token', 'KuGooToken', 'KugooToken', 'KG_TOKEN']);
}
function kugouCookieNickname(obj) {
  return kugouCookieValue(obj, ['NickName', 'nickname', 'nick', 'UserName', 'username', 'name']);
}
function kugouCookieAvatar(obj) {
  return kugouCookieValue(obj, ['Pic', 'pic', 'avatar', 'Avatar', 'headimg', 'headpic', 'photo']);
}
function normalizeKugouCookieInput(cookieText) {
  const obj = expandKugouCookieObject(parseCookieString(cookieText));
  const userId = kugouCookieUserId(obj);
  const token = kugouCookieToken(obj);
  if (userId && !obj.UserID) obj.UserID = userId;
  if (userId && !obj.userid) obj.userid = userId;
  if (token && !obj.token) obj.token = token;
  if (token && !obj.t) obj.t = token;
  if (!obj.mid && obj.kg_mid) obj.mid = obj.kg_mid;
  if (!obj.kg_mid && obj.mid) obj.kg_mid = obj.mid;
  if (!obj.kg_dfid && obj.dfid) obj.kg_dfid = obj.dfid;
  return serializeCookieObject(obj);
}
function sodaCookieObject() {
  return parseCookieString(sodaCookie);
}
function sodaCookieValue(obj, names) {
  obj = obj || sodaCookieObject();
  const lower = {};
  Object.keys(obj || {}).forEach(key => { lower[key.toLowerCase()] = obj[key]; });
  for (const name of names) {
    const value = obj[name] != null ? obj[name] : lower[String(name).toLowerCase()];
    if (value != null && String(value).trim() !== '') {
      try { return decodeURIComponent(String(value).replace(/\+/g, '%20')).trim(); }
      catch (e) { return String(value).trim(); }
    }
  }
  return '';
}
function sodaCookieUserId(obj) {
  return sodaCookieValue(obj, ['user_id', 'uid', 'uid_tt', 'uid_tt_ss', 'sid_uid', 'webid', 'od']);
}
function sodaCookieHasLogin(cookieText) {
  const obj = parseCookieString(cookieText || sodaCookie);
  return !!(obj.sessionid || obj.sessionid_ss || obj.sid_guard || obj.sid_tt || obj.sid_ucp_v1 || obj.uid_tt || obj.uid_tt_ss || obj.n_mh);
}
function normalizeSodaCookieInput(cookieText) {
  return normalizeCookieHeader(cookieText);
}
function playbackRestriction(provider, category, message, action, extra) {
  return {
    provider,
    category,
    action: action || '',
    message,
    ...(extra || {}),
  };
}
function classifyNeteasePlaybackRestriction(lastData, loginInfo) {
  const loggedIn = !!(loginInfo && loginInfo.loggedIn);
  const fee = Number(lastData && lastData.fee);
  const code = Number(lastData && lastData.code);
  const freeTrial = lastData && lastData.freeTrialInfo;
  if (!loggedIn) {
    return playbackRestriction('netease', 'login_required', '网易云需要登录后尝试获取完整播放地址', 'login', { code, fee });
  }
  if (freeTrial) {
    return playbackRestriction('netease', 'trial_only', '网易云仅返回试听片段，完整播放需要会员或购买', 'upgrade', { code, fee });
  }
  if (fee === 1) {
    return playbackRestriction('netease', 'vip_required', '网易云歌曲需要 VIP 权限，当前无法获取完整播放地址', 'upgrade', { code, fee });
  }
  if (fee === 4 || fee === 8) {
    return playbackRestriction('netease', 'paid_required', '网易云歌曲需要单曲、专辑购买或更高权限', 'purchase', { code, fee });
  }
  if (code === 404 || code === 403) {
    return playbackRestriction('netease', 'copyright_unavailable', '网易云版权暂不可播，换源或稍后重试会更稳', 'switch_source', { code, fee });
  }
  return playbackRestriction('netease', 'url_unavailable', '网易云没有返回可播放地址，可能是版权、会员或地区限制', loggedIn ? 'switch_source' : 'login', { code, fee });
}
function classifyQQPlaybackRestriction(info, session) {
  const hasSession = typeof session === 'object' ? !!session.hasSession : !!session;
  const hasPlaybackKey = typeof session === 'object' ? !!session.hasPlaybackKey : hasSession;
  const rawMsg = String((info && (info.msg || info.tips || info.errmsg || info.message)) || '').trim();
  const code = Number((info && (info.result || info.code || info.errtype)) || 0);
  const lower = rawMsg.toLowerCase();
  if (!hasSession) {
    return playbackRestriction('qq', 'login_required', 'QQ 音乐需要登录或授权后才能获取播放地址', 'login', { code, rawMessage: rawMsg });
  }
  if (!hasPlaybackKey && code === 104003) {
    return playbackRestriction('qq', 'login_required', 'QQ 音乐当前只拿到了网页登录状态，还缺少播放授权，请重新打开官方 QQ 音乐登录窗口完成授权', 'login', { code, rawMessage: rawMsg, missingPlaybackKey: true });
  }
  if (code === 104003) {
    return playbackRestriction('qq', 'copyright_unavailable', 'QQ 音乐没有给当前版本返回播放地址，通常是版权、会员或官方版本限制，可以换一个搜索结果或切到网易云源', 'switch_source', { code, rawMessage: rawMsg });
  }
  if (/vip|会员|付费|购买|数字专辑|专辑|pay/.test(lower + rawMsg)) {
    return playbackRestriction('qq', 'paid_required', 'QQ 音乐歌曲需要会员、购买或数字专辑权限', 'upgrade', { code, rawMessage: rawMsg });
  }
  if (code && code !== 0) {
    return playbackRestriction('qq', 'copyright_unavailable', rawMsg || 'QQ 音乐版权暂不可播或仅官方客户端可播', 'switch_source', { code, rawMessage: rawMsg });
  }
  return playbackRestriction('qq', 'url_unavailable', 'QQ 音乐没有返回播放地址，可能受版权、会员或官方客户端限制', 'switch_source', { code, rawMessage: rawMsg });
}
const NETEASE_QUALITY_CANDIDATES = [
  { level: 'jymaster', br: 1999000, label: '超清母带', svip: true },
  { level: 'hires',    br: 1999000, label: '高清臻音' },
  { level: 'lossless', br: 1411000, label: '无损' },
  { level: 'exhigh',   br: 999000,  label: '极高' },
  { level: 'standard', br: 128000,  label: '标准' },
];
const QQ_QUALITY_CANDIDATE_TEMPLATES = [
  { prefix: 'RS01', ext: '.flac', level: 'hires', label: 'Hi-Res FLAC' },
  { prefix: 'F000', ext: '.flac', level: 'lossless', label: '无损 FLAC' },
  { prefix: 'M800', ext: '.mp3', level: 'exhigh', label: '320k MP3' },
  { prefix: 'M500', ext: '.mp3', level: 'standard', label: '128k MP3' },
  { prefix: 'C400', ext: '.m4a', level: 'aac', label: 'AAC/M4A' },
];
function normalizeQualityPreference(value) {
  const raw = String(value || '').toLowerCase().trim();
  if (['jymaster', 'master', 'studio', 'svip'].includes(raw)) return 'jymaster';
  if (['hires', 'hi-res', 'highres', 'zhenyin', 'spatial'].includes(raw)) return 'hires';
  if (['lossless', 'flac', 'sq'].includes(raw)) return 'lossless';
  if (['exhigh', 'high', '320', '320k', 'hq'].includes(raw)) return 'exhigh';
  if (['standard', 'normal', '128', '128k', 'std'].includes(raw)) return 'standard';
  return 'hires';
}
function qualityCandidatesFrom(target, candidates) {
  target = normalizeQualityPreference(target);
  let start = candidates.findIndex(item => item.level === target);
  if (start < 0) start = 0;
  return candidates.slice(start);
}
function hasNeteaseSvip(loginInfo) {
  return !!(loginInfo && loginInfo.loggedIn && (loginInfo.vipLevel === 'svip' || loginInfo.isSvip || Number(loginInfo.vipType || 0) >= 10));
}
function mapArtists(raw) {
  return (raw || [])
    .map(a => ({ id: a && a.id, name: (a && a.name) || '' }))
    .filter(a => a.name);
}
function mapSongRecord(s) {
  s = s || {};
  const artists = mapArtists(s.ar || s.artists);
  const album = s.al || s.album || {};
  return {
    provider: 'netease',
    source: 'netease',
    type: 'song',
    id: s.id,
    name: s.name,
    artist: artists.map(a => a.name).join(' / '),
    artists,
    artistId: artists[0] && artists[0].id,
    album: album.name || '',
    cover: album.picUrl || album.coverUrl || '',
    duration: s.dt || s.duration || 0,
    fee: s.fee,
  };
}
function kugouSizedImage(url, size) {
  url = String(url || '').trim();
  if (!url) return '';
  url = url.replace(/\\\//g, '/').replace(/^\s*\/\//, 'https://');
  if (/^http:\/\//i.test(url)) url = url.replace(/^http:\/\//i, 'https://');
  size = size || 500;
  return url.replace(/\{size\}/g, String(size));
}
function mapKugouSongRecord(s) {
  s = s || {};
  const trans = s.trans_param || s.transParam || {};
  const hash = s.hash || s.file_hash || s.fileHash || '';
  const highHash = s.sqhash || s['320hash'] || s.hash320 || s.highhash || trans.ogg_320_hash || '';
  const cover = kugouSizedImage(trans.union_cover || s.album_img || s.imgurl || s.imgUrl || s.cover || '', 500);
  const singerInfo = Array.isArray(s.singerinfo) ? s.singerinfo : (Array.isArray(s.authors) ? s.authors : []);
  let singer = s.singername || s.singerName || s.author_name || s.authorName ||
    singerInfo.map(a => a && (a.name || a.author_name || a.singername)).filter(Boolean).join(' / ') || '';
  let name = s.songname || s.songName || s.filename || s.fileName || s.audio_name || s.name || '';
  name = String(name || '').replace(/\.(mp3|flac|m4a|ogg|wav)$/i, '');
  if (name && /\s+-\s+/.test(name)) {
    const parts = String(name).split(/\s+-\s+/);
    const prefix = parts.shift() || '';
    const rest = parts.join(' - ') || name;
    if (!singer) singer = prefix;
    if (!singer || prefix === singer || singer.split(/\s*(?:\/|,|\u3001)\s*/).includes(prefix)) name = rest;
  }
  const album = s.album_name || s.albumName || (s.albuminfo && s.albuminfo.name) || (s.album_info && s.album_info.name) || '';
  const rawDuration = Number(s.duration || s.timelength || s.timeLength || s.timelen || s.timeLen || 0) || 0;
  return {
    provider: 'kugou',
    source: 'kugou',
    type: 'kugou',
    id: s.album_audio_id || s.audio_id || s.mixsongid || hash || (name + '|' + singer),
    hash,
    highHash,
    sqhash: s.sqhash || '',
    hash320: s['320hash'] || s.hash320 || trans.ogg_320_hash || '',
    albumAudioId: s.album_audio_id || s.audio_id || s.mixsongid || '',
    albumId: s.album_id || s.albumid || s.req_albumid || '',
    name,
    artist: singer,
    artists: singer ? singer.split(/\s*(?:\/|,|\u3001)\s*/).filter(Boolean).map(name => ({ name })) : [],
    album,
    cover,
    duration: rawDuration * (rawDuration > 0 && rawDuration < 10000 ? 1000 : 1),
    fee: Number(s.pay_type || s.payType || s.privilege || s.media_pay_type || s.media_privilege || 0) || 0,
    playable: String(s.fail_process || s.media_fail_process || '') !== '4',
  };
}
function mapDiscoverPlaylist(pl, tag) {
  pl = pl || {};
  const creator = pl.creator || pl.user || {};
  const id = pl.id || pl.resourceId || pl.creativeId;
  return {
    provider: 'netease',
    source: 'netease',
    type: 'playlist',
    id,
    name: pl.name || pl.title || '',
    cover: pl.picUrl || pl.coverImgUrl || pl.coverUrl || pl.uiElement && pl.uiElement.image && pl.uiElement.image.imageUrl || '',
    trackCount: pl.trackCount || pl.songCount || pl.programCount || 0,
    playCount: pl.playCount || pl.playcount || 0,
    creator: creator.nickname || creator.name || '',
    tag: tag || pl.alg || '',
  };
}

function lowSignalText(value) {
  return String(value || '').trim().toLowerCase();
}

function isLowSignalPodcastItem(item) {
  const name = lowSignalText(item && (item.name || item.title || item.radioName));
  const sub = lowSignalText(item && (item.djName || item.category || item.desc || item.sub));
  const text = name + ' ' + sub;
  return /购买播客|付费精品|qzone|空间背景音乐|背景音乐|四只烤翅|试纸烤翅/i.test(text);
}

function isQQFavoritePlaylist(pl) {
  const name = String(pl && pl.name || '').trim();
  return /我喜欢|我的喜欢|喜欢的音乐/i.test(name);
}

function isQzoneBackgroundPlaylist(pl) {
  const text = String((pl && pl.name || '') + ' ' + (pl && pl.creator || '')).toLowerCase();
  return /qzone|空间|背景音乐/i.test(text);
}
async function requireLogin(res) {
  const info = await getLoginInfo();
  if (!info.loggedIn || !info.userId) {
    sendJSON(res, { error: 'LOGIN_REQUIRED', loggedIn: false }, 401);
    return null;
  }
  return info;
}

// ---------- 业务: 搜索 ----------
//   优先用 cloudsearch (新接口, 字段更全, picUrl 更稳定)
//   对于仍然缺失封面的歌曲, 用 song_detail 批量补齐
async function handleSearch(keywords, limit) {
  console.log('[Search]', keywords, 'limit:', limit);
  const result = await cloudsearch({ keywords, limit, cookie: userCookie });
  const songs = result.body && result.body.result && result.body.result.songs ? result.body.result.songs : [];

  let mapped = songs.map(s => {
    return mapSongRecord(s);
  });

  // 兜底: 补齐缺失的封面
  const missing = mapped.filter(s => !s.cover).map(s => s.id);
  if (missing.length) {
    try {
      console.log('[Search] backfilling covers for', missing.length, 'songs');
      const dd = await song_detail({ ids: missing.join(','), cookie: userCookie });
      const songsArr = (dd.body && dd.body.songs) || [];
      const idToPic = {};
      songsArr.forEach(s => {
        const pic = (s.al && s.al.picUrl) || (s.album && s.album.picUrl) || '';
        if (pic) idToPic[s.id] = pic;
      });
      mapped = mapped.map(s => s.cover ? s : { ...s, cover: idToPic[s.id] || '' });
    } catch (e) { console.warn('[Search] backfill failed:', e.message); }
  }

  return mapped;
}

async function handleDiscoverHome() {
  const info = await getLoginInfo();
  const loggedIn = !!(info && info.loggedIn);
  if (!loggedIn) {
    return {
      loggedIn: false,
      user: null,
      dailySongs: [],
      playlists: [],
      podcasts: [],
      mode: 'starter',
      updatedAt: Date.now(),
    };
  }
  const tasks = [
    personalized({ limit: 8, cookie: userCookie, timestamp: Date.now() }),
    dj_hot({ limit: 6, offset: 0, cookie: userCookie, timestamp: Date.now() }),
    recommend_resource({ cookie: userCookie, timestamp: Date.now() }),
    recommend_songs({ cookie: userCookie, timestamp: Date.now() }),
  ];
  const result = await Promise.allSettled(tasks);

  const personalizedBody = result[0].status === 'fulfilled' && result[0].value && result[0].value.body || {};
  const publicPlaylists = (personalizedBody.result || personalizedBody.data || [])
    .map(pl => mapDiscoverPlaylist(pl, '推荐歌单'))
    .filter(pl => pl.id && pl.name)
    .slice(0, 8);

  const podcastBody = result[1].status === 'fulfilled' && result[1].value && result[1].value.body || {};
  const podcastRaw = podcastBody.djRadios || podcastBody.djradios || podcastBody.radios || podcastBody.data || [];
  const podcasts = (Array.isArray(podcastRaw) ? podcastRaw : [])
    .map(mapPodcastRadio)
    .filter(p => p.id && !isLowSignalPodcastItem(p))
    .slice(0, 6);

  let privatePlaylists = [];
  if (result[2].status === 'fulfilled' && result[2].value) {
    const body = result[2].value.body || {};
    const raw = body.recommend || body.data || [];
    privatePlaylists = (Array.isArray(raw) ? raw : [])
      .map(pl => mapDiscoverPlaylist(pl, '私人推荐'))
      .filter(pl => pl.id && pl.name)
      .slice(0, 6);
  }

  let dailySongs = [];
  if (result[3].status === 'fulfilled' && result[3].value) {
    const body = result[3].value.body || {};
    const raw = body.data && (body.data.dailySongs || body.data.recommend) || body.recommend || [];
    dailySongs = (Array.isArray(raw) ? raw : [])
      .map(mapSongRecord)
      .filter(song => song.id && song.name)
      .slice(0, 12);
  }

  return {
    loggedIn,
    user: loggedIn ? { userId: info.userId, nickname: info.nickname || '', avatar: info.avatar || '' } : null,
    dailySongs,
    playlists: privatePlaylists.concat(publicPlaylists).slice(0, 10),
    podcasts,
    updatedAt: Date.now(),
  };
}

const QQ_MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const QQ_SMARTBOX_URL = 'https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg';
const KUGOU_SEARCH_URL = 'http://msearchcdn.kugou.com/api/v3/search/song';
const KUGOU_PLAYINFO_URL = 'https://m.kugou.com/app/i/getSongInfo.php';
const KUGOU_SPECIAL_SONG_URL = 'http://mobilecdn.kugou.com/api/v3/special/song';
const KUGOU_LYRIC_SEARCH_URL = 'http://lyrics.kugou.com/search';
const KUGOU_LYRIC_DOWNLOAD_URL = 'http://lyrics.kugou.com/download';
const KUGOU_GATEWAY_URL = 'https://gateway.kugou.com';
const KUGOU_WEB_SONGINFO_URL = 'https://wwwapi.kugou.com/play/songinfo';
const KUGOU_WEB_SONGINFO_RETRY_URL = 'https://wwwapiretry.kugou.com/play/songinfo';
const KUGOU_LOGIN_BY_TOKEN_URL = 'http://login.user.kugou.com/v5/login_by_token';
const KUGOU_H5_SIGN_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
const KUGOU_APP_PLAY_SALT = '57ae12eb6890223e355ccfcb74edf70d1005';
const KUGOU_APP_SIGN_SALT = 'OIlwieks28dk2k092lksi2UIkp';
const KUGOU_APP_KEY_SALT = '57ae12eb6890223e355ccfcb74edf70d';
const KUGOU_APP_ID = 1005;
const KUGOU_APP_CLIENTVER = 20489;
const KUGOU_WEB_COOKIE_KEYS = Object.freeze([
  'KuGoo',
  'KugooID',
  'kg_mid',
  'mid',
  'dfid',
  'kg_dfid',
  't',
  'token',
  'UserID',
  'userid',
  'ct',
  'a_id',
  'vip_type',
  'vip_token',
  'KUGOU_API_MID',
]);
const KUGOU_LOGIN_AES_KEY = '90b8382a1bb4ccdcf063102053fd75b8';
const KUGOU_LOGIN_AES_IV = 'f063102053fd75b8';
const KUGOU_PUBLIC_RSA_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/gbjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1+UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6DJE5E221wf/4WLFxwAtRQIDAQAB
-----END PUBLIC KEY-----`;
const SODA_SEARCH_URL = 'https://api.qishui.com/luna/pc/search/track';
const SODA_TRACK_V2_URL = 'https://api.qishui.com/luna/pc/track_v2';
const SODA_APP_API_BASE = 'https://api5-lq.qishui.com/luna';
const SODA_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const SODA_APP_USER_AGENT = 'SodaMusic/3.0.0 (Windows NT 10.0; Win64; x64)';
const DEFAULT_FFMPEG_BIN = 'D:\\ffmpeg\\ffmpeg-8.1-essentials_build\\bin\\ffmpeg.exe';
const FFMPEG_BIN = process.env.FFMPEG_BIN || (fs.existsSync(DEFAULT_FFMPEG_BIN) ? DEFAULT_FFMPEG_BIN : 'ffmpeg');
const SODA_AUDIO_CACHE_TTL_MS = 10 * 60 * 1000;
const SODA_AUDIO_CACHE_MAX_ENTRIES = 6;
const SODA_AUDIO_CACHE_MAX_BYTES = 72 * 1024 * 1024;
const SODA_AUDIO_BUFFER_MAX_BYTES = 36 * 1024 * 1024;
const sodaAudioCache = new Map();
const sodaAudioInflight = new Map();
let sodaAudioCacheBytes = 0;
const QQ_HEADERS = {
  Referer: 'https://y.qq.com/',
  'User-Agent': UA,
};
const KUGOU_HEADERS = {
  Referer: 'https://www.kugou.com/',
  Origin: 'https://www.kugou.com',
  'User-Agent': UA,
};

function requestText(targetUrl, opts, body) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode >= 400) {
          const err = new Error('HTTP ' + response.statusCode);
          err.statusCode = response.statusCode;
          err.body = text;
          reject(err);
          return;
        }
        resolve(text);
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function requestJson(targetUrl, opts, body) {
  const text = await requestText(targetUrl, opts, body);
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new Error('Invalid JSON from ' + targetUrl);
    err.cause = e;
    throw err;
  }
}

function clampNumber(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function openMeteoWeatherLabel(code) {
  code = Number(code);
  if (code === 0) return '晴';
  if (code === 1 || code === 2) return '少云';
  if (code === 3) return '阴';
  if (code === 45 || code === 48) return '雾';
  if (code === 51 || code === 53 || code === 55) return '毛毛雨';
  if (code === 56 || code === 57) return '冻雨';
  if (code === 61 || code === 63 || code === 65) return '雨';
  if (code === 66 || code === 67) return '冻雨';
  if (code === 71 || code === 73 || code === 75 || code === 77) return '雪';
  if (code === 80 || code === 81 || code === 82) return '阵雨';
  if (code === 85 || code === 86) return '阵雪';
  if (code === 95 || code === 96 || code === 99) return '雷雨';
  return '天气';
}

function buildWeatherMood(weather, date) {
  const now = date || new Date();
  const hour = now.getHours();
  const code = Number(weather && weather.weatherCode);
  const temp = Number(weather && weather.temperature);
  const apparent = Number(weather && weather.apparentTemperature);
  const rain = Number(weather && weather.precipitation) || 0;
  const humidity = Number(weather && weather.humidity) || 0;
  const wind = Number(weather && weather.windSpeed) || 0;
  const isNight = weather && weather.isDay === 0 || hour < 6 || hour >= 20;
  const isMorning = hour >= 5 && hour < 11;
  const isDusk = hour >= 17 && hour < 20;
  const isRain = rain > 0 || [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(code);
  const isSnow = [71, 73, 75, 77, 85, 86].includes(code);
  const isCloud = [2, 3, 45, 48].includes(code);
  const isStorm = [95, 96, 99].includes(code);
  const feels = Number.isFinite(apparent) ? apparent : temp;

  let mood = {
    key: 'clear',
    title: '晴朗电台',
    tagline: '让节奏亮一点，像窗边的光',
    energy: 0.62,
    warmth: 0.58,
    focus: 0.48,
    melancholy: 0.24,
    keywords: ['轻快 华语', 'city pop', 'indie pop', 'chill pop', '阳光 歌单'],
  };
  if (isStorm) {
    mood = {
      key: 'storm',
      title: '雷雨电台',
      tagline: '低频更厚，适合把世界关小一点',
      energy: 0.46,
      warmth: 0.34,
      focus: 0.66,
      melancholy: 0.62,
      keywords: ['暗色 R&B', 'trip hop', '夜晚 电子', '氛围 摇滚', '雨夜 歌单'],
    };
  } else if (isRain) {
    mood = {
      key: 'rain',
      title: '雨天电台',
      tagline: '留一点潮湿的空间给旋律',
      energy: 0.38,
      warmth: 0.42,
      focus: 0.64,
      melancholy: 0.66,
      keywords: ['雨天 R&B', 'lofi rainy', '华语 慢歌', 'dream pop', '雨夜 歌单'],
    };
  } else if (isSnow || feels <= 3) {
    mood = {
      key: 'snow',
      title: '冷空气电台',
      tagline: '干净、慢速、带一点冬天的颗粒感',
      energy: 0.34,
      warmth: 0.28,
      focus: 0.72,
      melancholy: 0.54,
      keywords: ['冬天 民谣', 'ambient piano', '日系 冬天', 'indie folk', '安静 歌单'],
    };
  } else if (feels >= 31 || humidity >= 78) {
    mood = {
      key: 'humid',
      title: '闷热电台',
      tagline: '降低密度，留出一点呼吸',
      energy: 0.48,
      warmth: 0.76,
      focus: 0.46,
      melancholy: 0.30,
      keywords: ['夏日 chill', 'bossa nova', 'city pop 夏天', '轻电子', '海边 歌单'],
    };
  } else if (isCloud) {
    mood = {
      key: 'cloudy',
      title: '阴天电台',
      tagline: '不急着明亮，先让声音变软',
      energy: 0.40,
      warmth: 0.46,
      focus: 0.58,
      melancholy: 0.52,
      keywords: ['阴天 华语', 'indie rock mellow', 'neo soul', 'chillhop', '独立 民谣'],
    };
  }

  if (isNight) {
    mood.key += '-night';
    mood.title = mood.key.startsWith('clear') ? '夜色电台' : mood.title.replace('电台', '夜听');
    mood.tagline = '音量放低一点，让夜色参与编曲';
    mood.energy = Math.min(mood.energy, 0.42);
    mood.focus = Math.max(mood.focus, 0.68);
    mood.melancholy = Math.max(mood.melancholy, 0.52);
    mood.keywords = ['夜晚 R&B', 'late night jazz', 'ambient', 'lofi sleep', '夜跑 歌单'].concat(mood.keywords.slice(0, 3));
  } else if (isMorning) {
    mood.title = mood.key.startsWith('rain') ? '雨晨电台' : '早晨电台';
    mood.energy = Math.max(mood.energy, 0.52);
    mood.keywords = ['早晨 通勤', 'morning acoustic', '清晨 indie', '轻快 华语'].concat(mood.keywords.slice(0, 3));
  } else if (isDusk) {
    mood.title = mood.key.startsWith('rain') ? '黄昏雨声' : '黄昏电台';
    mood.melancholy = Math.max(mood.melancholy, 0.48);
    mood.keywords = ['黄昏 city pop', '日落 歌单', '落日飞车', 'soul pop'].concat(mood.keywords.slice(0, 3));
  }

  if (wind >= 28) {
    mood.energy = Math.max(mood.energy, 0.56);
    mood.keywords = ['公路 摇滚', 'windy day playlist'].concat(mood.keywords.slice(0, 4));
  }
  mood.keywords = Array.from(new Set(mood.keywords)).slice(0, 7);
  return mood;
}

async function resolveOpenMeteoLocation(query) {
  const raw = String(query || '').trim();
  if (!raw) return WEATHER_DEFAULT_LOCATION;
  const u = new URL(OPEN_METEO_GEOCODE_URL);
  u.searchParams.set('name', raw);
  u.searchParams.set('count', '1');
  u.searchParams.set('language', 'zh');
  u.searchParams.set('format', 'json');
  const body = await requestJson(u.toString(), { headers: { 'User-Agent': UA } });
  const first = body && Array.isArray(body.results) && body.results[0];
  if (!first) return { ...WEATHER_DEFAULT_LOCATION, query: raw, fallback: true };
  return {
    name: first.name || raw,
    country: first.country || '',
    admin1: first.admin1 || '',
    latitude: first.latitude,
    longitude: first.longitude,
    timezone: first.timezone || 'auto',
  };
}

async function fetchOpenMeteoWeather(params) {
  params = params || {};
  let location;
  const lat = clampNumber(params.lat, -90, 90, NaN);
  const lon = clampNumber(params.lon, -180, 180, NaN);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    location = {
      name: String(params.city || params.name || '当前位置').trim() || '当前位置',
      country: '',
      latitude: lat,
      longitude: lon,
      timezone: params.timezone || 'auto',
    };
  } else {
    location = await resolveOpenMeteoLocation(params.city || params.q || params.location);
  }
  const u = new URL(OPEN_METEO_FORECAST_URL);
  u.searchParams.set('latitude', String(location.latitude));
  u.searchParams.set('longitude', String(location.longitude));
  u.searchParams.set('current', 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m');
  u.searchParams.set('hourly', 'precipitation_probability,weather_code,temperature_2m');
  u.searchParams.set('forecast_days', '1');
  u.searchParams.set('timezone', location.timezone || 'auto');
  const body = await requestJson(u.toString(), { headers: { 'User-Agent': UA } });
  const cur = body && body.current || {};
  const weather = {
    provider: 'open-meteo',
    location: {
      name: location.name,
      country: location.country || '',
      admin1: location.admin1 || '',
      latitude: location.latitude,
      longitude: location.longitude,
      timezone: body.timezone || location.timezone || '',
      fallback: !!location.fallback,
    },
    label: openMeteoWeatherLabel(cur.weather_code),
    weatherCode: Number(cur.weather_code),
    temperature: Number(cur.temperature_2m),
    apparentTemperature: Number(cur.apparent_temperature),
    humidity: Number(cur.relative_humidity_2m),
    precipitation: Number(cur.precipitation || cur.rain || cur.showers || cur.snowfall || 0),
    cloudCover: Number(cur.cloud_cover),
    windSpeed: Number(cur.wind_speed_10m),
    windGusts: Number(cur.wind_gusts_10m),
    isDay: Number(cur.is_day),
    time: cur.time || '',
    updatedAt: Date.now(),
  };
  weather.mood = buildWeatherMood(weather);
  return weather;
}

async function fetchIpWeatherLocation() {
  const u = new URL(WEATHER_IP_LOCATION_URL);
  u.searchParams.set('fields', 'status,message,country,regionName,city,lat,lon,timezone,query');
  u.searchParams.set('lang', 'zh-CN');
  const body = await requestJson(u.toString(), { headers: { 'User-Agent': UA } });
  if (!body || body.status !== 'success' || !Number.isFinite(Number(body.lat)) || !Number.isFinite(Number(body.lon))) {
    const err = new Error(body && body.message || 'IP_LOCATION_FAILED');
    err.body = body;
    throw err;
  }
  return {
    provider: 'ip-api',
    city: body.city || WEATHER_DEFAULT_LOCATION.name,
    region: body.regionName || '',
    country: body.country || '',
    latitude: Number(body.lat),
    longitude: Number(body.lon),
    timezone: body.timezone || 'auto',
    ip: body.query || '',
  };
}

function weatherRadioSeedQueries(mood) {
  const key = String(mood && mood.key || '');
  if (key.includes('rain') || key.includes('storm')) return ['陈奕迅 阴天快乐', '周杰伦 雨下一整晚', '孙燕姿 遇见', '林宥嘉 说谎', '毛不易 消愁'];
  if (key.includes('snow') || key.includes('cloudy')) return ['陈奕迅 好久不见', '莫文蔚 阴天', '李健 贝加尔湖畔', '朴树 平凡之路', '蔡健雅 达尔文'];
  if (key.includes('humid')) return ['落日飞车 My Jinji', '告五人 爱人错过', '夏日入侵企画 想去海边', '陈绮贞 旅行的意义', '王若琳 Lost in Paradise'];
  if (key.includes('night')) return ['方大同 特别的人', '陶喆 爱很简单', 'Frank Ocean Pink + White', '林忆莲 夜太黑', "Norah Jones Don't Know Why"];
  return ['孙燕姿 天黑黑', '周杰伦 晴天', '五月天 温柔', '陈奕迅 稳稳的幸福', '王菲'];
}

function fallbackWeatherForRadio(params, err) {
  params = params || {};
  const name = String(params.city || params.q || params.location || WEATHER_DEFAULT_LOCATION.name).trim() || WEATHER_DEFAULT_LOCATION.name;
  return {
    provider: 'open-meteo',
    location: {
      name,
      country: '',
      admin1: '',
      latitude: null,
      longitude: null,
      timezone: params.timezone || WEATHER_DEFAULT_LOCATION.timezone,
      fallback: true,
    },
    label: '天气暂不可用',
    weatherCode: null,
    temperature: null,
    apparentTemperature: null,
    humidity: null,
    precipitation: null,
    cloudCover: null,
    windSpeed: null,
    windGusts: null,
    isDay: null,
    time: '',
    updatedAt: Date.now(),
    error: err && err.message || '',
    mood: {
      key: 'fallback',
      title: '临时电台',
      tagline: '天气暂时没有回来，先放一组稳妥的歌',
      energy: 0.54,
      warmth: 0.55,
      focus: 0.55,
      melancholy: 0.35,
      keywords: ['华语 流行', 'indie pop', 'city pop', '轻快 歌单', 'chill pop'],
    },
  };
}

function uniqueSongsByKey(songs) {
  const seen = new Set();
  const out = [];
  (songs || []).forEach(song => {
    const key = String(song && (song.id || song.name + '|' + song.artist) || '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(song);
  });
  return out;
}

function tagWeatherPoolSongs(songs, source) {
  return (songs || []).map(song => ({ ...song, weatherSource: source }));
}

async function fetchWeatherPlaylistSongs(playlist, limit) {
  const id = playlist && playlist.id;
  if (!id) return [];
  let rawTracks = [];
  try {
    if (typeof playlist_track_all === 'function') {
      const all = await playlist_track_all({ id, limit: limit || 36, offset: 0, cookie: userCookie, timestamp: Date.now() });
      rawTracks = (all.body && (all.body.songs || all.body.tracks)) || [];
    }
  } catch (e) {
    console.warn('[WeatherRadio] playlist_track_all failed:', playlist && playlist.name, e.message);
  }
  if (!rawTracks.length && typeof playlist_detail === 'function') {
    try {
      const detail = await playlist_detail({ id, s: 0, cookie: userCookie, timestamp: Date.now() });
      const pl = (detail.body && detail.body.playlist) || {};
      rawTracks = pl.tracks || [];
    } catch (e) {
      console.warn('[WeatherRadio] playlist_detail failed:', playlist && playlist.name, e.message);
    }
  }
  return rawTracks.map(mapSongRecord).filter(song => song.id && song.name).slice(0, limit || 36);
}

async function filterLikelyPlayableWeatherSongs(songs) {
  const source = uniqueSongsByKey(songs)
    .filter(song => song && song.name && song.id && !isLowSignalWeatherSong(song))
    .slice(0, 24);
  const playable = [];
  const fallback = source.slice(0, 24);
  for (let i = 0; i < source.length; i += 4) {
    const chunk = source.slice(i, i + 4);
    const settled = await Promise.allSettled(chunk.map(async song => {
      const info = await handleSongUrl(song.id, { loggedIn: !!userCookie }, 'standard');
      return info && info.url ? song : null;
    }));
    settled.forEach((result, idx) => {
      if (result.status === 'fulfilled' && result.value) playable.push(result.value);
      else if (result.status === 'rejected') console.warn('[WeatherRadio] playable probe failed:', chunk[idx] && chunk[idx].name, result.reason && result.reason.message);
    });
    if (playable.length >= 12) break;
  }
  return (playable.length ? playable : fallback).slice(0, 24);
}

function isLowSignalWeatherSong(song) {
  const text = String([
    song && song.name,
    song && song.artist,
    song && song.album,
  ].filter(Boolean).join(' ')).toLowerCase();
  if (!text) return true;
  if (/(^|[\s\-_/（(])ai(?:\s*(歌|歌曲|音乐|cover|翻唱|生成|作曲|演唱|女声|男声)|$|[\s\-_/）)])/i.test(text)) return true;
  if (/suno|udio|人工智能|生成歌曲|ai歌曲|虚拟歌手|测试音频|demo|beat\s*maker/i.test(text)) return true;
  if (/翻自|翻唱|cover|remix|伴奏|纯音乐|钢琴|dj|live\s*版|live版|唯美钢琴|karaoke|instrumental/i.test(text)) return true;
  if (/白噪音|雨声|睡眠|助眠|冥想|疗愈频率|环境音|自然声音|asmr/i.test(text)) return true;
  if (/[（(](r&b|lofi|jazz|dj|edm|trap|remix|伴奏|纯音乐|钢琴|电子|治愈|古风|女声|男声|英文|中文版|抖音|ai)[）)]/i.test(text)) return true;
  if (/^(纯音乐|轻音乐|治愈系|放松|睡眠|雨天|阴天|夜晚|夏日|海边)$/i.test(String(song.name || '').trim())) return true;
  return false;
}

function scoreWeatherSong(song, mood) {
  const text = String((song && song.name || '') + ' ' + (song && song.artist || '') + ' ' + (song && song.album || '')).toLowerCase();
  let score = 0;
  if (song && song.cover) score += 4;
  if (song && song.duration) score += 2;
  if (song && song.weatherSource === 'daily') score += 6;
  if (song && song.weatherSource === 'private') score += 4;
  if (/周杰伦|陈奕迅|孙燕姿|五月天|王菲|陶喆|方大同|林宥嘉|蔡健雅|莫文蔚|李健|毛不易|告五人|落日飞车|陈绮贞|朴树/.test(text)) score += 10;
  const key = String(mood && mood.key || '');
  if (key.includes('rain') && /雨|阴|夜|慢|r&b|soul|陈奕迅|林宥嘉|孙燕姿/.test(text)) score += 5;
  if (key.includes('humid') && /夏|海|city|pop|落日|告五人|方大同|陶喆/.test(text)) score += 5;
  if (key.includes('night') && /夜|moon|jazz|soul|r&b|方大同|陶喆|王菲/.test(text)) score += 5;
  if (key.includes('cloudy') && /阴|民谣|indie|陈绮贞|朴树|李健/.test(text)) score += 5;
  return score;
}

function weatherArtistKey(song) {
  const raw = String(song && song.artist || song && song.name || '').split(/\s*\/\s*|、|,|&/)[0] || '';
  return raw.trim().toLowerCase() || 'unknown';
}

function weatherTitleKey(song) {
  return String(song && song.name || '')
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s._\-·'’"“”「」《》:：/\\|]+/g, '')
    .trim();
}

function uniqueWeatherTitles(sorted) {
  const seen = new Set();
  const out = [];
  (sorted || []).forEach(song => {
    const key = weatherTitleKey(song);
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    out.push(song);
  });
  return out;
}

function diversifyWeatherSongs(sorted, artistLimit) {
  const primary = [];
  const deferred = [];
  const counts = new Map();
  (sorted || []).forEach(song => {
    const key = weatherArtistKey(song);
    const count = counts.get(key) || 0;
    if (count < artistLimit) {
      primary.push(song);
      counts.set(key, count + 1);
    } else {
      deferred.push(song);
    }
  });
  return primary.length >= 8 ? primary : primary.concat(deferred.slice(0, 8 - primary.length));
}

function orderWeatherSongs(songs, mood) {
  const sorted = uniqueSongsByKey(songs)
    .filter(song => song && song.name && song.id && !isLowSignalWeatherSong(song))
    .sort((a, b) => scoreWeatherSong(b, mood) - scoreWeatherSong(a, mood));
  return diversifyWeatherSongs(uniqueWeatherTitles(sorted), 2);
}

async function buildWeatherRadio(params) {
  let weather;
  try {
    weather = await fetchOpenMeteoWeather(params);
  } catch (e) {
    console.warn('[WeatherRadio] weather provider failed, using fallback radio:', e.message);
    weather = fallbackWeatherForRadio(params, e);
  }
  const queries = weatherRadioSeedQueries(weather.mood);
  let songs = [];
  const settled = await Promise.allSettled(queries.slice(0, 4).map(q => handleSearch(q, 6)));
  settled.forEach(result => {
    if (result.status === 'fulfilled' && Array.isArray(result.value)) songs = songs.concat(result.value);
  });
  if (songs.length < 10 && weather.mood && Array.isArray(weather.mood.keywords)) {
    const more = await Promise.allSettled(weather.mood.keywords.slice(0, 2).map(q => handleSearch(q, 6)));
    more.forEach(result => {
      if (result.status === 'fulfilled' && Array.isArray(result.value)) songs = songs.concat(result.value);
    });
  }
  songs = orderWeatherSongs(songs, weather.mood);
  return {
    ok: true,
    weather,
    radio: {
      title: weather.mood.title,
      subtitle: weather.mood.tagline,
      seedQueries: queries.slice(0, 4),
      songs: songs.slice(0, 18),
      updatedAt: Date.now(),
    },
  };
}

function parseJSONText(text) {
  const raw = String(text || '').trim();
  const json = raw.replace(/^callback\(([\s\S]*)\);?$/, '$1');
  return JSON.parse(json);
}

async function qqMusicRequest(payload, opts) {
  opts = opts || {};
  const body = JSON.stringify(payload);
  const headers = {
    ...QQ_HEADERS,
    'Content-Type': 'application/json;charset=UTF-8',
    'Content-Length': Buffer.byteLength(body),
  };
  if (opts.cookie && qqCookie) headers.Cookie = qqCookie;
  const text = await requestText(QQ_MUSICU_URL, {
    method: 'POST',
    headers,
  }, body);
  return parseJSONText(text);
}

function normalizeQQProfile(body, cookieObj) {
  cookieObj = cookieObj || qqCookieObject();
  const uin = qqCookieUin(cookieObj);
  const data = (body && (body.data || body.profile || body.creator || body.result)) || {};
  const creator = (data.creator || data.user || data.profile || data) || {};
  const vipInfo = data.vipInfo || data.vipinfo || data.vip || creator.vipInfo || creator.vipinfo || {};
  const profileNick = creator.nick || creator.nickname || creator.name || creator.hostname || creator.title || '';
  const profileAvatar = creator.headpic || creator.avatar || creator.avatarUrl || creator.logo || '';
  const cookieNick = qqCookieNickname(cookieObj, uin);
  const nick = profileNick || cookieNick || '';
  const avatar = profileAvatar || qqCookieAvatar(cookieObj, uin);
  let vipType = Number(
    cookieObj.vipType || cookieObj.vip_type ||
    data.vipType || data.vip_type || data.viptype || data.music_vip_level || data.green_vip_level || data.luxury_vip_level ||
    creator.vipType || creator.vip_type || creator.music_vip_level || creator.green_vip_level || creator.luxury_vip_level ||
    vipInfo.vipType || vipInfo.vip_type || vipInfo.music_vip_level || vipInfo.green_vip_level || vipInfo.luxury_vip_level || 0
  ) || 0;
  if (!vipType) {
    const vipFlag = data.isVip || data.is_vip || data.vipFlag || data.vipflag || creator.isVip || creator.is_vip || vipInfo.isVip || vipInfo.is_vip || vipInfo.vipFlag;
    if (vipFlag === true || Number(vipFlag) > 0 || String(vipFlag || '').toLowerCase() === 'true') vipType = 1;
  }
  return {
    provider: 'qq',
    loggedIn: !!(uin && qqCookieMusicKey(cookieObj)),
    preview: false,
    userId: uin,
    nickname: nick || (uin ? ('QQ ' + uin) : 'QQ 音乐'),
    avatar,
    vipType,
    hasCookie: !!qqCookie,
    playbackKeyReady: !!qqCookiePlaybackKey(cookieObj),
    profileSource: profileNick || profileAvatar ? 'qq-profile' : (cookieNick || avatar ? 'cookie' : 'fallback'),
  };
}

async function getQQLoginInfo() {
  const cookieObj = qqCookieObject();
  const uin = qqCookieUin(cookieObj);
  const musicKey = qqCookieMusicKey(cookieObj);
  if (!uin || !musicKey) return { provider: 'qq', loggedIn: false, hasCookie: !!qqCookie };
  const fallback = normalizeQQProfile(null, cookieObj);
  try {
    const u = new URL('https://c.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg');
    u.searchParams.set('cid', '205360838');
    u.searchParams.set('userid', uin);
    u.searchParams.set('reqfrom', '1');
    u.searchParams.set('g_tk', '5381');
    u.searchParams.set('loginUin', uin);
    u.searchParams.set('hostUin', '0');
    u.searchParams.set('format', 'json');
    u.searchParams.set('inCharset', 'utf8');
    u.searchParams.set('outCharset', 'utf-8');
    u.searchParams.set('notice', '0');
    u.searchParams.set('platform', 'yqq.json');
    u.searchParams.set('needNewCode', '0');
    const text = await requestText(u.toString(), {
      headers: { ...QQ_HEADERS, Cookie: qqCookie },
    });
    const body = parseJSONText(text);
    const info = normalizeQQProfile(body, cookieObj);
    if (body && (body.code === 1000 || body.result === 301)) {
      return { ...fallback, profileUnavailable: true };
    }
    return info;
  } catch (e) {
    console.warn('[QQLogin] profile check failed:', e.message);
    return { ...fallback, profileUnavailable: true };
  }
}

async function getKugouLoginInfo() {
  const cookieObj = kugouCookieObject();
  const userId = kugouCookieUserId(cookieObj);
  const token = kugouCookieToken(cookieObj);
  const nickname = kugouCookieNickname(cookieObj);
  const avatar = kugouCookieAvatar(cookieObj);
  const vipType = Number(kugouCookieValue(cookieObj, ['vip_type', 'vipType', 'viptype']) || 0) || 0;
  const vipToken = kugouCookieValue(cookieObj, ['vip_token', 'vipToken', 'VIP_TOKEN']);
  return {
    provider: 'kugou',
    loggedIn: !!(userId && token),
    preview: false,
    userId,
    nickname: nickname || (userId ? ('酷狗 ' + userId) : '酷狗音乐'),
    avatar,
    vipType,
    vipLevel: vipType > 0 ? 'vip' : 'none',
    isVip: vipType > 0,
    vipLabel: vipType > 0 ? '酷狗 VIP' : '已登录，待会员授权',
    hasCookie: !!kugouCookie,
    tokenReady: !!token,
    vipTokenReady: !!vipToken,
    playlistReady: !!(userId && token),
    profileSource: nickname || avatar ? 'cookie' : 'fallback',
  };
}

async function qqGetJSON(targetUrl, params, opts) {
  opts = opts || {};
  const u = new URL(targetUrl);
  Object.keys(params || {}).forEach(k => {
    if (params[k] != null) u.searchParams.set(k, String(params[k]));
  });
  const headers = { ...QQ_HEADERS, ...(opts.headers || {}) };
  if (opts.cookie !== false && qqCookie) headers.Cookie = qqCookie;
  const text = await requestText(u.toString(), { headers });
  return parseJSONText(text);
}

async function kugouGetJSON(targetUrl, params, opts) {
  opts = opts || {};
  const u = new URL(targetUrl);
  Object.keys(params || {}).forEach(k => {
    if (params[k] != null && params[k] !== '') u.searchParams.set(k, String(params[k]));
  });
  const text = await requestText(u.toString(), {
    headers: { ...KUGOU_HEADERS, ...(opts.headers || {}) },
  });
  return parseJSONText(text);
}

function md5Hex(input) {
  return crypto.createHash('md5').update(String(input || '')).digest('hex');
}

function kugouRandomString(len) {
  const chars = '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function kugouAesEncrypt(data, opt) {
  opt = opt || {};
  const text = typeof data === 'object' ? JSON.stringify(data) : String(data || '');
  const tempKey = opt.key || kugouRandomString(16).toLowerCase();
  const key = opt.iv ? opt.key : md5Hex(tempKey).slice(0, 32);
  const iv = opt.iv || key.slice(-16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  const hex = Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()]).toString('hex');
  return opt.key && opt.iv ? hex : { str: hex, key: tempKey };
}

function kugouAesDecrypt(hex, tempKey) {
  const key = md5Hex(tempKey).slice(0, 32);
  const iv = key.slice(-16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  const text = Buffer.concat([decipher.update(Buffer.from(String(hex || ''), 'hex')), decipher.final()]).toString('utf8');
  try { return JSON.parse(text); } catch (e) { return text; }
}

function kugouRsaRawEncrypt(data) {
  const input = Buffer.from(typeof data === 'object' ? JSON.stringify(data) : String(data || ''), 'utf8');
  const padded = Buffer.alloc(128);
  input.copy(padded, 0, 0, Math.min(input.length, padded.length));
  return crypto.publicEncrypt({
    key: KUGOU_PUBLIC_RSA_KEY,
    padding: crypto.constants.RSA_NO_PADDING,
  }, padded).toString('hex');
}

function kugouAndroidSignature(params, bodyText) {
  const parts = Object.keys(params || {}).sort().map(key => {
    const value = params[key];
    return `${key}=${value && typeof value === 'object' ? JSON.stringify(value) : value}`;
  });
  return md5Hex(`${KUGOU_APP_SIGN_SALT}${parts.join('')}${bodyText || ''}${KUGOU_APP_SIGN_SALT}`);
}

function kugouAppSignKey(hash, mid, userId, appId) {
  return md5Hex(`${hash}${KUGOU_APP_KEY_SALT}${appId || KUGOU_APP_ID}${mid || ''}${userId || 0}`);
}

async function kugouAndroidRequest(targetUrl, params, opts) {
  opts = opts || {};
  const device = {
    ...kugouCookieDevice(opts.cookieObj),
    ...(opts.device || {}),
  };
  const clienttime = Math.floor(Date.now() / 1000);
  const merged = {
    dfid: device.dfid || '-',
    mid: device.mid || '-',
    uuid: '-',
    appid: opts.appid || KUGOU_APP_ID,
    clientver: opts.clientver || KUGOU_APP_CLIENTVER,
    clienttime,
    ...(params || {}),
  };
  if (device.token && merged.token == null) merged.token = device.token;
  if (device.userId && merged.userid == null) merged.userid = device.userId;
  const bodyText = opts.body == null ? '' : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
  if (!opts.notSignature && !opts.notSign && !merged.signature) merged.signature = kugouAndroidSignature(merged, bodyText);
  const u = new URL(targetUrl);
  const query = Object.keys(merged)
    .filter(key => merged[key] != null)
    .map(key => {
      let value = encodeURIComponent(String(merged[key]));
      if (key === 'ppage_id') value = value.replace(/%2C/gi, ',');
      return `${encodeURIComponent(key)}=${value}`;
    })
    .join('&');
  const requestUrl = u.toString() + (u.search ? '&' : '?') + query;
  const headers = {
    ...KUGOU_HEADERS,
    'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
    dfid: merged.dfid,
    mid: merged.mid,
    clienttime: merged.clienttime,
    'kg-rc': '1',
    'kg-thash': '5d816a0',
    'kg-rec': '1',
    'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
    ...(opts.headers || {}),
  };
  if (bodyText) {
    headers['Content-Type'] = 'application/json;charset=UTF-8';
    headers['Content-Length'] = Buffer.byteLength(bodyText);
  }
  const text = await requestText(requestUrl, {
    method: opts.method || (bodyText ? 'POST' : 'GET'),
    headers,
  }, bodyText);
  return parseKugouTaggedJSON(text);
}

function kugouCookieDevice(obj) {
  obj = obj || kugouCookieObject();
  return {
    userId: kugouCookieUserId(obj),
    token: kugouCookieToken(obj),
    mid: kugouCookieValue(obj, ['kg_mid', 'mid', 'KUGOU_API_MID']) || 'undefined',
    dfid: kugouCookieValue(obj, ['dfid', 'kg_dfid', 'DFID']) || '-',
    vipType: Number(kugouCookieValue(obj, ['vip_type', 'vipType', 'viptype']) || 0) || 0,
    vipToken: kugouCookieValue(obj, ['vip_token', 'vipToken', 'VIP_TOKEN']),
  };
}

function kugouRawCookieValue(obj, name) {
  const lowerName = String(name || '').toLowerCase();
  const key = Object.keys(obj || {}).find(k => String(k).toLowerCase() === lowerName);
  return key ? obj[key] : '';
}

function kugouCookieHeaderValue(value) {
  let text = String(value || '').trim();
  if (!text) return '';
  if (/[^\x21-\x7e]|[;\r\n]/.test(text)) {
    const decoded = decodeKugouCookieValue(text);
    try { text = encodeURIComponent(decoded || text); }
    catch (e) { text = encodeURIComponent(text); }
  }
  return text.replace(/[\r\n;]/g, ch => encodeURIComponent(ch));
}

function kugouWebCookieHeader(obj) {
  obj = obj || kugouCookieObject();
  const rawObj = parseCookieString(kugouCookie);
  const picked = [];
  KUGOU_WEB_COOKIE_KEYS.forEach(key => {
    const rawValue = kugouRawCookieValue(rawObj, key);
    const value = rawValue || kugouCookieValue(obj, [key]);
    const safeValue = kugouCookieHeaderValue(value);
    if (safeValue) picked.push(`${key}=${safeValue}`);
  });
  return picked.join('; ');
}

function kugouWebPlaybackDevice(obj) {
  obj = obj || kugouCookieObject();
  const mid = kugouCookieValue(obj, ['kg_mid', 'mid']) ||
    kugouCookieValue(obj, ['KUGOU_API_MID']) ||
    md5Hex(`${Date.now()}-${Math.random()}`);
  return {
    userId: kugouCookieUserId(obj) || '0',
    token: kugouCookieToken(obj) || '',
    mid,
    dfid: kugouCookieValue(obj, ['dfid', 'kg_dfid', 'DFID']) || '-',
  };
}

async function refreshKugouMobileLoginCookie(cookieText) {
  const obj = expandKugouCookieObject(parseCookieString(cookieText));
  const device = kugouCookieDevice(obj);
  if (!device.userId || !device.token) return cookieText;
  const now = Date.now();
  const loginCipher = kugouAesEncrypt({
    clienttime: Math.floor(now / 1000),
    token: device.token,
  }, { key: KUGOU_LOGIN_AES_KEY, iv: KUGOU_LOGIN_AES_IV });
  const paramsCipher = kugouAesEncrypt({});
  const body = {
    dfid: device.dfid || '-',
    p3: loginCipher,
    plat: 1,
    t1: 0,
    t2: 0,
    t3: 'MCwwLDAsMCwwLDAsMCwwLDA=',
    pk: kugouRsaRawEncrypt({ clienttime_ms: now, key: paramsCipher.key }),
    params: paramsCipher.str,
    userid: device.userId,
    clienttime_ms: now,
  };
  try {
    const json = await kugouAndroidRequest(KUGOU_LOGIN_BY_TOKEN_URL, {}, {
      device,
      method: 'POST',
      body,
    });
    if (Number(json && json.status) !== 1) return cookieText;
    const data = { ...((json && json.data) || {}) };
    if (data.secu_params) {
      const decrypted = kugouAesDecrypt(data.secu_params, paramsCipher.key);
      if (decrypted && typeof decrypted === 'object') Object.assign(data, decrypted);
      else if (decrypted) data.token = decrypted;
    }
    const next = {
      ...obj,
      userid: data.userid || device.userId,
      UserID: data.userid || device.userId,
      KugooID: data.userid || device.userId,
      token: data.token || device.token,
      t: data.token || device.token,
      t1: data.t1 || obj.t1 || '',
      vip_type: data.vip_type || obj.vip_type || obj.vipType || 0,
      vip_token: data.vip_token || obj.vip_token || '',
      dfid: device.dfid || obj.dfid || '-',
      kg_dfid: device.dfid || obj.kg_dfid || '-',
      mid: device.mid || obj.mid || '',
      kg_mid: device.mid || obj.kg_mid || '',
      KUGOU_API_MID: obj.KUGOU_API_MID || '',
    };
    return serializeCookieObject(next);
  } catch (e) {
    console.warn('[KugouLogin] token refresh failed:', e.message);
    return cookieText;
  }
}

function kugouH5Signature(params, bodyText) {
  const parts = Object.keys(params || {}).sort().map(k => `${k}=${params[k]}`);
  if (bodyText) parts.push(bodyText);
  return md5Hex([KUGOU_H5_SIGN_SALT, ...parts, KUGOU_H5_SIGN_SALT].join(''));
}

async function kugouH5SignedRequest(pathname, body, opts) {
  opts = opts || {};
  const device = {
    ...kugouCookieDevice(opts.cookieObj),
    ...(opts.device || {}),
  };
  if (!device.userId || !device.token) {
    const err = new Error('KUGOU_LOGIN_REQUIRED');
    err.code = 'KUGOU_LOGIN_REQUIRED';
    throw err;
  }
  const bodyText = body == null ? '' : JSON.stringify(body);
  const params = {
    srcappid: 2919,
    clientver: 20000,
    clienttime: Date.now(),
    mid: device.mid,
    uuid: device.mid,
    dfid: device.dfid,
    appid: 1014,
    plat: 4,
    userid: device.userId,
    token: device.token,
    ...(opts.params || {}),
  };
  params.signature = kugouH5Signature(params, bodyText);
  const u = new URL(pathname, KUGOU_GATEWAY_URL);
  Object.keys(params).forEach(k => {
    if (params[k] != null && params[k] !== '') u.searchParams.set(k, String(params[k]));
  });
  const headers = {
    ...KUGOU_HEADERS,
    'User-Agent': opts.userAgent || UA,
    ...(opts.headers || {}),
  };
  if (bodyText) {
    headers['Content-Type'] = 'application/json;charset=UTF-8';
    headers['Content-Length'] = Buffer.byteLength(bodyText);
  }
  const text = await requestText(u.toString(), {
    method: opts.method || (bodyText ? 'POST' : 'GET'),
    headers,
  }, bodyText);
  return parseJSONText(text);
}

function kugouGatewayOk(json) {
  if (!json) return false;
  const status = Number(json.status);
  const errorCode = Number(json.error_code);
  return status === 1 && (!Number.isFinite(errorCode) || errorCode === 0);
}

function normalizeKugouHash(song, preferHigh) {
  song = song || {};
  if (preferHigh) {
    return song.sqhash || song.hash320 || song['320hash'] || song.highHash || song.hash || '';
  }
  return song.hash || song.file_hash || song.fileHash || song.sqhash || song.hash320 || song['320hash'] || '';
}

function audioProxyHeadersFor(audioUrl, range) {
  const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/' };
  try {
    const host = new URL(audioUrl).hostname.toLowerCase();
    if (host.includes('qq.com') || host.includes('qpic.cn')) headers.Referer = 'https://y.qq.com/';
    if (host.includes('kugou.com')) headers.Referer = 'https://www.kugou.com/';
  } catch (e) {}
  if (range) headers.Range = range;
  return headers;
}

function audioContentTypeForUrl(audioUrl, upstreamType) {
  let pathname = '';
  try { pathname = new URL(audioUrl).pathname.toLowerCase(); } catch (e) {}
  if (/\.flac$/.test(pathname)) return 'audio/flac';
  if (/\.mp3$/.test(pathname)) return 'audio/mpeg';
  if (/\.(m4a|mp4)$/.test(pathname)) return 'audio/mp4';
  if (/\.ogg$/.test(pathname)) return 'audio/ogg';
  if (/\.wav$/.test(pathname)) return 'audio/wav';
  return upstreamType || 'audio/mpeg';
}

function mapQQPlaylist(pl, kind) {
  pl = pl || {};
  const id = pl.dissid || pl.tid || pl.dirid || pl.id || pl.diss_id;
  return {
    provider: 'qq',
    source: 'qq',
    id: id ? String(id) : '',
    name: pl.diss_name || pl.name || pl.title || '',
    cover: pl.diss_cover || pl.logo || pl.picurl || pl.cover || '',
    trackCount: pl.song_cnt || pl.songnum || pl.total_song_num || pl.song_count || 0,
    playCount: pl.listen_num || pl.visitnum || pl.play_count || 0,
    creator: pl.hostname || pl.nick || pl.creator || 'QQ 音乐',
    subscribed: kind === 'collect',
    specialType: 0,
  };
}

function mapQQPlaylistTrack(raw) {
  raw = raw || {};
  const track = raw.songid || raw.songmid || raw.mid || raw.name ? raw : (raw.track_info || raw.songInfo || raw.songinfo || raw.song || {});
  const album = track.album || {};
  const artists = mapQQArtists(track.singer || track.singers || []);
  const mid = track.mid || track.songmid || raw.mid || raw.songmid || '';
  const albumMid = album.mid || track.albummid || raw.albummid || '';
  return {
    provider: 'qq',
    source: 'qq',
    type: 'qq',
    id: mid || String(track.id || track.songid || raw.id || raw.songid || ''),
    qqId: track.id || track.songid || raw.id || raw.songid || '',
    mid,
    songmid: mid,
    mediaMid: (track.file && track.file.media_mid) || track.strMediaMid || track.media_mid || raw.strMediaMid || '',
    name: track.name || track.songname || raw.songname || '',
    artist: artists.map(a => a.name).join(' / ') || track.singername || raw.singername || '',
    artists,
    artistId: artists[0] && (artists[0].id || artists[0].mid),
    artistMid: artists[0] && artists[0].mid,
    album: album.name || album.title || track.albumname || raw.albumname || '',
    albumMid,
    cover: qqAlbumCover(albumMid, 300),
    duration: (Number(track.interval || raw.interval) || 0) * 1000,
    fee: track.pay && Number(track.pay.pay_play) ? 1 : 0,
    playable: false,
  };
}

async function handleQQUserPlaylists() {
  const info = await getQQLoginInfo();
  if (!info.loggedIn || !info.userId) return { loggedIn: false, provider: 'qq', playlists: [] };
  const uin = info.userId;
  const createdReq = qqGetJSON('https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss', {
    hostUin: 0,
    hostuin: uin,
    sin: 0,
    size: 200,
    g_tk: 5381,
    loginUin: uin,
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    notice: 0,
    platform: 'yqq.json',
    needNewCode: 0,
  }, { headers: { Referer: 'https://y.qq.com/portal/profile.html' } });
  const collectReq = qqGetJSON('https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg', {
    ct: 20,
    cid: 205360956,
    userid: uin,
    reqtype: 3,
    sin: 0,
    ein: 80,
  }, { headers: { Referer: 'https://y.qq.com/portal/profile.html' } });
  const [createdRaw, collectRaw] = await Promise.allSettled([createdReq, collectReq]);
  const created = createdRaw.status === 'fulfilled' && createdRaw.value && createdRaw.value.data && Array.isArray(createdRaw.value.data.disslist)
    ? createdRaw.value.data.disslist.map(pl => mapQQPlaylist(pl, 'created')) : [];
  const collected = collectRaw.status === 'fulfilled' && collectRaw.value && collectRaw.value.data && Array.isArray(collectRaw.value.data.cdlist)
    ? collectRaw.value.data.cdlist.map(pl => mapQQPlaylist(pl, 'collect')) : [];
  const seen = new Set();
  const playlists = created.concat(collected).filter(pl => {
    if (!pl.id || !pl.name || seen.has(pl.id)) return false;
    if (isQzoneBackgroundPlaylist(pl)) return false;
    seen.add(pl.id);
    return true;
  }).sort((a, b) => Number(isQQFavoritePlaylist(b)) - Number(isQQFavoritePlaylist(a)));
  return { loggedIn: true, provider: 'qq', userId: uin, playlists };
}

async function handleQQPlaylistTracks(id) {
  const info = await getQQLoginInfo();
  if (!info.loggedIn || !info.userId) return { loggedIn: false, provider: 'qq', tracks: [] };
  const pid = String(id || '').trim();
  if (!pid) return { loggedIn: true, provider: 'qq', error: 'Missing QQ playlist id', tracks: [] };
  const result = await qqGetJSON('https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg', {
    type: 1,
    utf8: 1,
    disstid: pid,
    loginUin: info.userId,
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    notice: 0,
    platform: 'yqq.json',
    needNewCode: 0,
  }, { headers: { Referer: 'https://y.qq.com/n/yqq/playlist' } });
  const detail = result && result.cdlist && result.cdlist[0] ? result.cdlist[0] : {};
  const rawTracks = Array.isArray(detail.songlist) ? detail.songlist : [];
  const tracks = rawTracks.map(mapQQPlaylistTrack).filter(s => s.name && (s.mid || s.id));
  const playlist = {
    provider: 'qq',
    id: pid,
    name: detail.dissname || detail.diss_name || detail.name || '',
    cover: detail.logo || detail.diss_cover || '',
    trackCount: tracks.length,
  };
  return { loggedIn: true, provider: 'qq', playlist, tracks };
}

function qqAlbumCover(albumMid, size) {
  if (!albumMid) return '';
  const px = size || 300;
  return 'https://y.qq.com/music/photo_new/T002R' + px + 'x' + px + 'M000' + albumMid + '.jpg?max_age=2592000';
}

function qqSingerAvatar(singerMid, size) {
  if (!singerMid) return '';
  const px = size || 300;
  return 'https://y.qq.com/music/photo_new/T001R' + px + 'x' + px + 'M000' + singerMid + '.jpg?max_age=2592000';
}

function mapQQArtists(raw) {
  return (raw || [])
    .map(a => ({
      id: a && a.id,
      mid: a && a.mid,
      name: (a && (a.name || a.title)) || '',
    }))
    .filter(a => a.name);
}

function mapQQSmartSong(item) {
  item = item || {};
  const mid = item.mid || item.songmid || item.id || '';
  return {
    provider: 'qq',
    source: 'qq',
    type: 'qq',
    id: mid,
    qqId: item.id || item.docid || '',
    mid,
    songmid: mid,
    name: item.name || item.title || '',
    artist: item.singer || '',
    artists: item.singer ? [{ name: item.singer }] : [],
    album: '',
    cover: '',
    duration: 0,
    fee: 0,
    playable: false,
  };
}

function mapQQTrack(track, fallback) {
  track = track || {};
  fallback = fallback || {};
  const album = track.album || {};
  const artists = mapQQArtists(track.singer || []);
  const mid = track.mid || fallback.mid || fallback.songmid || '';
  const albumMid = album.mid || album.pmid || '';
  return {
    provider: 'qq',
    source: 'qq',
    type: 'qq',
    id: mid,
    qqId: track.id || fallback.qqId || fallback.id || '',
    mid,
    songmid: mid,
    mediaMid: track.file && track.file.media_mid,
    name: track.name || track.title || fallback.name || '',
    artist: artists.map(a => a.name).join(' / ') || fallback.artist || '',
    artists: artists.length ? artists : (fallback.artists || []),
    artistId: artists[0] && (artists[0].id || artists[0].mid),
    artistMid: artists[0] && artists[0].mid,
    album: album.name || album.title || fallback.album || '',
    albumMid,
    cover: qqAlbumCover(albumMid, 300) || fallback.cover || '',
    duration: (Number(track.interval) || 0) * 1000,
    fee: track.pay && Number(track.pay.pay_play) ? 1 : 0,
    playable: false,
  };
}

async function qqSmartboxSearch(keywords, limit) {
  const u = new URL(QQ_SMARTBOX_URL);
  u.searchParams.set('format', 'json');
  u.searchParams.set('key', keywords);
  u.searchParams.set('g_tk', '5381');
  u.searchParams.set('loginUin', '0');
  u.searchParams.set('hostUin', '0');
  u.searchParams.set('inCharset', 'utf8');
  u.searchParams.set('outCharset', 'utf-8');
  u.searchParams.set('notice', '0');
  u.searchParams.set('platform', 'yqq.json');
  u.searchParams.set('needNewCode', '0');
  const text = await requestText(u.toString(), { headers: QQ_HEADERS });
  const json = parseJSONText(text);
  const items = json && json.data && json.data.song && json.data.song.itemlist;
  return (Array.isArray(items) ? items : []).slice(0, Math.max(1, Math.min(limit || 6, 10))).map(mapQQSmartSong);
}

async function qqSongDetail(mid, fallback) {
  if (!mid) return fallback;
  const json = await qqMusicRequest({
    comm: { ct: 24, cv: 0 },
    songinfo: {
      module: 'music.pf_song_detail_svr',
      method: 'get_song_detail_yqq',
      param: { song_mid: mid },
    },
  });
  const data = json && json.songinfo && json.songinfo.data;
  return mapQQTrack(data && data.track_info, fallback);
}

async function handleQQArtistDetail(mid, limit) {
  const singerMid = String(mid || '').trim();
  const num = Math.max(10, Math.min(80, parseInt(limit || '36', 10) || 36));
  if (!singerMid) return { provider: 'qq', error: 'MISSING_SINGER_MID', artist: null, songs: [] };
  const json = await qqMusicRequest({
    comm: { ct: 24, cv: 0 },
    singer: {
      module: 'music.web_singer_info_svr',
      method: 'get_singer_detail_info',
      param: { sort: 5, singermid: singerMid, sin: 0, num },
    },
  }, { cookie: true });
  const block = json && json.singer;
  if (!block || Number(block.code || 0) !== 0) {
    return { provider: 'qq', error: block && (block.message || block.msg || block.code) || 'QQ_ARTIST_DETAIL_FAILED', artist: null, songs: [] };
  }
  const data = block.data || {};
  const info = data.singer_info || data.singerInfo || {};
  const rawSongs = Array.isArray(data.songlist) ? data.songlist : [];
  const songs = rawSongs
    .map(raw => mapQQTrack(raw && (raw.track_info || raw.songInfo || raw.songinfo || raw.song) || raw, {}))
    .filter(song => song && song.name && (song.mid || song.id));
  const matchedSongArtist = songs[0] && (songs[0].artists || []).find(a => a && a.mid === singerMid);
  const artistMid = info.mid || singerMid;
  const artistName = info.name || info.title || (matchedSongArtist && matchedSongArtist.name) || '';
  const totalSong = Number(data.total_song || data.song_count || 0) || songs.length;
  return {
    provider: 'qq',
    artist: {
      provider: 'qq',
      id: info.id || '',
      mid: artistMid,
      name: artistName,
      avatar: info.pic || info.avatar || qqSingerAvatar(artistMid, 300),
      fans: Number(info.fans || 0) || 0,
      musicSize: totalSong,
      albumSize: Number(data.total_album || 0) || 0,
      mvSize: Number(data.total_mv || 0) || 0,
    },
    total: totalSong,
    songs,
  };
}

async function handleQQSearch(keywords, limit) {
  const kw = String(keywords || '').trim();
  if (!kw) return [];
  console.log('[QQSearch]', kw, 'limit:', limit);
  const base = await qqSmartboxSearch(kw, limit);
  const detailed = await Promise.all(base.map(async item => {
    try { return await qqSongDetail(item.mid, item); }
    catch (e) {
      console.warn('[QQSearch] detail failed:', item.mid, e.message);
      return item;
    }
  }));
  const seen = new Set();
  return detailed.filter(song => {
    const key = song && (song.mid || song.id || (song.name + '|' + song.artist));
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return !!song.name;
  });
}

async function handleKugouSearch(keywords, limit) {
  const kw = String(keywords || '').trim();
  if (!kw) return [];
  console.log('[KugouSearch]', kw, 'limit:', limit);
  const json = await kugouGetJSON(KUGOU_SEARCH_URL, {
    plat: 0,
    version: 9108,
    keyword: kw,
    page: 1,
    pagesize: Math.max(4, Math.min(24, parseInt(limit || '12', 10) || 12)),
    showtype: 1,
  });
  const list = json && json.data && Array.isArray(json.data.info) ? json.data.info : [];
  const seen = new Set();
  return list.map(mapKugouSongRecord).filter(song => {
    const key = song && (song.hash || song.id || (song.name + '|' + song.artist));
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return !!song.name;
  });
}

function kugouUserPlaylistTrackCount(pl) {
  return Number(pl && (pl.count || pl.m_count || pl.per_count || pl.music_count || pl.total || 0)) || 0;
}

function mapKugouUserPlaylist(pl, userId) {
  pl = pl || {};
  const listId = pl.listid || pl.list_create_listid || '';
  const globalId = pl.global_collection_id || pl.list_create_gid ||
    (listId ? `collection_3_${pl.list_create_userid || userId || 0}_${listId}_0` : '');
  const cover = kugouSizedImage(pl.pic || pl.sizable_cover || pl.cover || pl.img || pl.create_user_pic || '', 300);
  return {
    provider: 'kugou',
    source: 'kugou',
    id: globalId ? String(globalId) : String(listId || ''),
    listid: listId ? String(listId) : '',
    globalCollectionId: globalId ? String(globalId) : '',
    name: pl.name || pl.listname || pl.title || '',
    cover,
    trackCount: kugouUserPlaylistTrackCount(pl),
    playCount: Number(pl.play_count || pl.playcount || pl.listen_num || 0) || 0,
    creator: pl.list_create_username || pl.create_username || pl.username || 'Kugou',
    subscribed: Number(pl.is_mine || 0) === 0,
    specialType: 0,
  };
}

function extractKugouPersonalListId(id) {
  const raw = String(id || '').trim();
  if (!raw) return '';
  if (/^collection_/i.test(raw)) {
    const parts = raw.split('_');
    return parts[3] ? String(parts[3]).replace(/[^\w-]/g, '') : '';
  }
  return raw.replace(/[^\w-]/g, '');
}

async function handleKugouUserPlaylists(page, pagesize) {
  const cookieObj = kugouCookieObject();
  const device = kugouCookieDevice(cookieObj);
  device.mid = kugouCookieValue(cookieObj, ['KUGOU_API_MID']) || device.mid || 'undefined';
  if (!device.dfid || device.dfid === '-') device.dfid = kugouRandomString(24);
  if (!device.userId || !device.token) {
    return { loggedIn: false, provider: 'kugou', playlists: [], playlistReady: false };
  }
  const pageNo = Math.max(1, parseInt(page || '1', 10) || 1);
  const size = Math.max(10, Math.min(200, parseInt(pagesize || '100', 10) || 100));
  const body = {
    userid: device.userId,
    total_ver: 979,
    type: 2,
    page: pageNo,
    pagesize: size,
  };
  const json = await kugouH5SignedRequest('/v7/get_all_list', body, {
    cookieObj,
    device,
    headers: { 'x-router': 'cloudlist.service.kugou.com' },
  });
  if (!kugouGatewayOk(json)) {
    const err = new Error('KUGOU_USER_PLAYLISTS_FAILED_' + (json && (json.error_code || json.status || 'UNKNOWN')));
    err.body = json;
    throw err;
  }
  const data = json.data || {};
  const seen = new Set();
  const playlists = (Array.isArray(data.info) ? data.info : [])
    .map(pl => mapKugouUserPlaylist(pl, device.userId))
    .filter(pl => {
      if (!pl.id || !pl.name || seen.has(pl.id)) return false;
      seen.add(pl.id);
      return true;
    });
  return {
    loggedIn: true,
    provider: 'kugou',
    userId: device.userId,
    playlistReady: true,
    total: Number(data.list_count || data.collect_count || playlists.length) || playlists.length,
    playlists,
  };
}

function mapKugouPlaylistTrack(raw) {
  return mapKugouSongRecord(raw || {});
}

function compactKugouGatewayAttempt(label, json, extra) {
  return {
    label,
    status: json && json.status,
    error_code: json && json.error_code,
    message: json && (json.error || json.message || json.msg),
    ...(extra || {}),
  };
}

function kugouPlaylistInfoRows(data) {
  data = data || {};
  if (Array.isArray(data.info)) return data.info;
  if (Array.isArray(data.list)) return data.list;
  if (Array.isArray(data.songs)) return data.songs;
  return [];
}

async function handleKugouPersonalPlaylistTracks(id, limit) {
  const cookieObj = kugouCookieObject();
  const device = kugouCookieDevice(cookieObj);
  if (!device.userId || !device.token) return { loggedIn: false, provider: 'kugou', tracks: [] };
  const rawId = String(id || '').trim();
  const listId = extractKugouPersonalListId(id);
  if (!listId) return { loggedIn: true, provider: 'kugou', error: 'Missing Kugou playlist id', playlist: null, tracks: [] };
  const requestedLimit = parseInt(limit || '50', 10) || 50;
  const pageSize = Math.max(1, Math.min(50, requestedLimit));
  const globalCollectionId = /^collection_/i.test(rawId) ? rawId : '';
  const baseBody = {
    listid: listId,
    userid: device.userId,
    area_code: 1,
    show_relate_goods: 0,
    pagesize: pageSize,
    allplatform: 1,
    show_cover: 1,
    type: 0,
    token: device.token,
    page: 1,
  };
  const bodyWithoutToken = { ...baseBody };
  delete bodyWithoutToken.token;
  const variants = [
    { label: 'v4-primary', pathname: '/v4/get_list_all_file', body: baseBody },
    { label: 'v4-primary-retry', pathname: '/v4/get_list_all_file', body: baseBody, delay: 180 },
    { label: 'v4-no-token-body', pathname: '/v4/get_list_all_file', body: bodyWithoutToken },
    { label: 'v4-type2', pathname: '/v4/get_list_all_file', body: { ...baseBody, type: 2 } },
    { label: 'v4-plat0', pathname: '/v4/get_list_all_file', body: baseBody, params: { plat: 0 } },
    { label: 'v3-primary', pathname: '/v3/get_list_all_file', body: baseBody },
  ];
  if (globalCollectionId) {
    variants.splice(3, 0, {
      label: 'v4-global-id',
      pathname: '/v4/get_list_all_file',
      body: { ...baseBody, global_collection_id: globalCollectionId },
    });
  }
  const attempts = [];
  let emptyOkResult = null;
  for (const variant of variants) {
    if (variant.delay) await new Promise(resolve => setTimeout(resolve, variant.delay));
    try {
      const json = await kugouH5SignedRequest(variant.pathname, variant.body, {
        cookieObj,
        device,
        params: variant.params || {},
        headers: { 'x-router': 'cloudlist.service.kugou.com' },
      });
      const data = json && json.data || {};
      const rawTracks = kugouPlaylistInfoRows(data);
      attempts.push(compactKugouGatewayAttempt(variant.label, json, {
        count: Number(data.count || rawTracks.length) || rawTracks.length,
        rows: rawTracks.length,
      }));
      if (!kugouGatewayOk(json)) continue;
      const tracks = rawTracks.map(mapKugouPlaylistTrack).filter(song => song && song.name && (song.hash || song.id));
      const expectedCount = Number(data.count || data.total || tracks.length || rawTracks.length) || tracks.length;
      const result = {
        loggedIn: true,
        provider: 'kugou',
        playlist: {
          provider: 'kugou',
          id: String(id || listId),
          listid: String(listId),
          name: data.name || data.listname || '',
          cover: '',
          trackCount: expectedCount,
        },
        tracks,
        attempts,
      };
      if (tracks.length || expectedCount <= 0) return result;
      emptyOkResult = emptyOkResult || result;
    } catch (err) {
      attempts.push({
        label: variant.label,
        error: err.message,
        statusCode: err.statusCode || 0,
      });
    }
  }
  if (emptyOkResult) return emptyOkResult;
  const last = attempts[attempts.length - 1] || {};
  const code = last.error_code || last.status || last.statusCode || 'UNKNOWN';
  const err = new Error('KUGOU_PLAYLIST_TRACKS_FAILED_' + code);
  err.body = { provider: 'kugou', attempts };
  throw err;
}

async function handleKugouPlaylistTracks(id, limit) {
  const specialId = String(id || '').replace(/[^\w-]/g, '').trim();
  if (!specialId) return { provider: 'kugou', error: 'Missing Kugou playlist id', playlist: null, tracks: [] };
  if (/^collection_/i.test(String(id || '').trim())) return handleKugouPersonalPlaylistTracks(id, limit);
  const maybePersonalListId = /^\d{1,5}$/.test(specialId);
  if (maybePersonalListId) {
    try {
      const personal = await handleKugouPersonalPlaylistTracks(specialId, limit);
      if (personal && Array.isArray(personal.tracks) && personal.tracks.length) return personal;
    } catch (e) {
      // Numeric public special IDs still use the public endpoint below.
    }
  }
  const json = await kugouGetJSON(KUGOU_SPECIAL_SONG_URL, {
    specialid: specialId,
    area_code: 1,
    page: 1,
    plat: 2,
    pagesize: Math.max(1, Math.min(500, parseInt(limit || '500', 10) || 500)),
    version: 8990,
  }, { headers: { 'User-Agent': 'IPhone-8990-searchSong' } });
  const data = json && json.data || {};
  const rawTracks = Array.isArray(data.info) ? data.info : [];
  const tracks = rawTracks.map(mapKugouPlaylistTrack).filter(song => song && song.name && (song.hash || song.id));
  return {
    provider: 'kugou',
    playlist: {
      provider: 'kugou',
      id: specialId,
      name: data.specialname || data.special_name || data.name || '',
      cover: kugouSizedImage(data.img || data.pic || data.sizable_cover || data.cover || '', 300),
      trackCount: Number(data.total || data.count || tracks.length) || tracks.length,
    },
    tracks,
  };
}

function classifyKugouPlaybackRestriction(info) {
  const rawMessage = String((info && (info.error || info.msg || info.message)) || '').trim();
  const payType = Number(info && (info.pay_type || info.payType || 0)) || 0;
  const privilege = Number(info && (info.privilege || info['128privilege'] || 0)) || 0;
  const status = Number(info && info.status);
  const lower = rawMessage.toLowerCase();
  if (/付费|会员|购买|vip|pay/.test(lower + rawMessage) || payType > 0 || privilege > 0 || status === 2) {
    return playbackRestriction('kugou', 'paid_required', '酷狗音乐当前接口未获得这首歌的会员播放授权', 'upgrade', { payType, privilege, rawMessage, status });
  }
  return playbackRestriction('kugou', 'url_unavailable', rawMessage || '酷狗音乐没有返回可播放地址，可能受版权、会员或地区限制', 'switch_source', { payType, privilege, rawMessage, status });
}

async function handleKugouSongInfo(hash, albumId) {
  const h = String(hash || '').trim();
  if (!h) return null;
  const info = await kugouGetJSON(KUGOU_PLAYINFO_URL, {
    cmd: 'playInfo',
    hash: h,
    album_id: albumId || '',
  });
  return info || null;
}

function firstKugouPlayableUrl(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    const text = value.trim();
    return /^https?:\/\//i.test(text) ? text : '';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstKugouPlayableUrl(item);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const found = firstKugouPlayableUrl(value[key]);
      if (found) return found;
    }
  }
  return '';
}

function compactKugouPlayAttempt(label, info) {
  const ok = Number(info && info.status) === 1;
  const data = info && info.data && typeof info.data === 'object' ? info.data : null;
  return {
    label,
    status: info && info.status,
    errorCode: info && (info.error_code || info.err_code || info.errcode || info.code || data && (data.error_code || data.err_code || data.code)),
    error: info && (info.error || info.message || info.msg || info.errmsg || data && (data.error || data.message || data.msg || data.errmsg)),
    hasUrl: ok && !!firstKugouPlayableUrl(info && (
      info.url || info.play_url || info.playUrl || info.play_backup_url || info.backup_url ||
      data && (data.url || data.play_url || data.playUrl || data.play_backup_url || data.backup_url)
    )),
  };
}

function parseKugouTaggedJSON(text) {
  const clean = String(text || '')
    .replace(/<!--KG_TAG_RES_START-->/g, '')
    .replace(/<!--KG_TAG_RES_END-->/g, '')
    .trim();
  return parseJSONText(clean);
}

async function handleKugouAppSongInfo(hash, albumId, albumAudioId) {
  const h = String(hash || '').trim();
  if (!h) return null;
  const cookieObj = kugouCookieObject();
  const device = kugouCookieDevice(cookieObj);
  const userId = device.userId || '0';
  const token = device.token || '';
  const mid = device.mid || String(Date.now());
  const dfid = device.dfid || '-';
  const normalizedHash = h.toUpperCase();
  const key = md5Hex(normalizedHash + KUGOU_APP_PLAY_SALT + mid + userId);
  const params = {
    dfid,
    pid: '2',
    mid,
    cmd: '26',
    token,
    hash: normalizedHash,
    area_code: '1',
    behavior: 'play',
    appid: '1005',
    module: '',
    vipType: '6',
    ptype: '1',
    userid: userId,
    mtype: '1',
    album_id: albumId || '',
    pidversion: '3001',
    key,
    version: '10209',
    album_audio_id: albumAudioId || '',
    with_res_tag: '1',
  };
  const u = new URL('/i/v2/', KUGOU_GATEWAY_URL);
  Object.keys(params).forEach(k => {
    if (params[k] != null && params[k] !== '') u.searchParams.set(k, String(params[k]));
  });
  const headers = {
    ...KUGOU_HEADERS,
    'User-Agent': 'Android511-AndroidPhone-10159-18-0-SearchAll-wifi',
    'x-router': 'tracker.kugou.com',
  };
  const text = await requestText(u.toString(), { headers });
  return parseKugouTaggedJSON(text);
}

async function handleKugouOfficialWebSongInfo(hash, albumId, albumAudioId, encodeAlbumAudioId) {
  const h = String(hash || '').trim();
  const encodedAudioId = String(encodeAlbumAudioId || '').trim();
  if (!h && !encodedAudioId) return null;
  const cookieObj = kugouCookieObject();
  const device = kugouWebPlaybackDevice(cookieObj);
  const cookieHeader = kugouWebCookieHeader(cookieObj);
  const params = {
    srcappid: '2919',
    clientver: '20000',
    clienttime: Date.now(),
    mid: device.mid,
    uuid: device.mid,
    dfid: device.dfid,
    appid: 1014,
    platid: 4,
  };
  if (device.token) params.token = device.token;
  if (device.userId) params.userid = device.userId;
  if (encodedAudioId) {
    params.encode_album_audio_id = encodedAudioId;
  } else {
    params.hash = h.toUpperCase();
    if (albumId) params.album_id = albumId;
    if (albumAudioId) params.album_audio_id = albumAudioId;
  }
  params.signature = kugouH5Signature(params);

  const requestUrls = [KUGOU_WEB_SONGINFO_URL, KUGOU_WEB_SONGINFO_RETRY_URL];
  let last = null;
  for (const endpoint of requestUrls) {
    const u = new URL(endpoint);
    Object.keys(params).forEach(key => {
      if (params[key] != null) u.searchParams.set(key, String(params[key]));
    });
    const headers = {
      ...KUGOU_HEADERS,
      Referer: encodedAudioId
        ? `https://www.kugou.com/mixsong/${encodeURIComponent(encodedAudioId)}.html`
        : 'https://www.kugou.com/',
      'User-Agent': UA,
    };
    if (cookieHeader) headers.Cookie = cookieHeader;
    try {
      const text = await requestText(u.toString(), { headers });
      const json = parseJSONText(text);
      last = { ...(json || {}), requestedKugouEndpoint: endpoint };
      const data = last && last.data && typeof last.data === 'object' ? last.data : last;
      const playableUrl = firstKugouPlayableUrl(data && (
        data.play_url || data.playUrl || data.url || data.play_backup_url || data.backup_url
      ));
      if (Number(last && last.status) === 1 && playableUrl) return last;
    } catch (e) {
      last = { status: 0, error: e.message, requestedKugouEndpoint: endpoint };
    }
  }
  return last;
}

function kugouQualityCandidates(qualityPreference) {
  const q = normalizeQualityPreference(qualityPreference);
  if (q === 'standard') return ['128', '320'];
  if (q === 'high') return ['320', '128'];
  return ['flac', '320', '128'];
}

async function handleKugouV5SongInfo(hash, albumId, albumAudioId, qualityPreference) {
  const h = String(hash || '').trim();
  if (!h) return null;
  const cookieObj = kugouCookieObject();
  const device = kugouCookieDevice(cookieObj);
  if (!device.userId || !device.token) return null;
  const hashLower = h.toLowerCase();
  const qualities = kugouQualityCandidates(qualityPreference);
  let last = null;
  for (const quality of qualities) {
    const params = {
      album_id: Number(albumId || 0),
      area_code: 1,
      hash: hashLower,
      ssa_flag: 'is_fromtrack',
      version: 11430,
      page_id: 151369488,
      quality,
      album_audio_id: Number(albumAudioId || 0),
      behavior: 'play',
      pid: 2,
      cmd: 26,
      pidversion: 3001,
      IsFreePart: 0,
      ppage_id: '463467626,350369493,788954147',
      cdnBackup: 1,
      module: '',
      clientver: 11430,
      key: kugouAppSignKey(hashLower, device.mid, device.userId, KUGOU_APP_ID),
    };
    try {
      const json = await kugouAndroidRequest(new URL('/v5/url', KUGOU_GATEWAY_URL).toString(), params, {
        device,
        headers: { 'x-router': 'trackercdn.kugou.com' },
      });
      last = { ...(json || {}), requestedKugouQuality: quality };
      const url = firstKugouPlayableUrl(json && (json.url || json.play_url || json.playUrl || json.play_backup_url || json.backup_url));
      if (Number(json && json.status) === 1 && url) return last;
    } catch (e) {
      last = { status: 0, error: e.message, requestedKugouQuality: quality };
    }
  }
  return last;
}

async function handleKugouSongUrl(hash, albumId, qualityPreference, albumAudioId, encodeAlbumAudioId) {
  const requestedQuality = normalizeQualityPreference(qualityPreference);
  const h = String(hash || '').trim();
  const encodedAudioId = String(encodeAlbumAudioId || '').trim();
  if (!h && !encodedAudioId) return { provider: 'kugou', url: '', playable: false, error: 'MISSING_HASH', message: 'Missing Kugou song hash' };
  let info = null;
  try {
    info = h ? await handleKugouSongInfo(h, albumId) : null;
  } catch (e) {
    info = { status: 0, error: e.message };
  }
  const url = firstKugouPlayableUrl(info && (info.url || info.play_url || info.playUrl));
  const cover = kugouSizedImage(info && (info.album_img || info.imgUrl || info.imgurl || info.image), 500);
  if (Number(info && info.status) === 1 && url) {
    return {
      provider: 'kugou',
      url,
      trial: false,
      playable: true,
      level: requestedQuality,
      quality: info && (info.extName || info.bitRate || info.bitRate === 0) ? String(info.extName || info.bitRate) : '酷狗音源',
      br: info && (info.bitRate || info.bitrate || 0),
      cover,
      requestedQuality,
      playbackSource: 'kugou-web',
    };
  }
  let officialWebInfo = null;
  try {
    officialWebInfo = await handleKugouOfficialWebSongInfo(h, albumId, albumAudioId, encodedAudioId);
  } catch (e) {
    officialWebInfo = { status: 0, error: e.message };
  }
  const officialData = officialWebInfo && officialWebInfo.data && typeof officialWebInfo.data === 'object'
    ? officialWebInfo.data
    : officialWebInfo;
  const officialUrl = firstKugouPlayableUrl(officialData && (
    officialData.play_url || officialData.playUrl || officialData.url ||
    officialData.play_backup_url || officialData.backup_url
  ));
  if (Number(officialWebInfo && officialWebInfo.status) === 1 && officialUrl) {
    return {
      provider: 'kugou',
      url: officialUrl,
      trial: Number(officialData && officialData.is_free_part) === 1,
      playable: true,
      level: requestedQuality,
      quality: officialData && (officialData.extname || officialData.extName || officialData.fileExt || officialData.bitrate || officialData.bitRate)
        ? String(officialData.extname || officialData.extName || officialData.fileExt || officialData.bitrate || officialData.bitRate)
        : 'kugou-official-web',
      br: officialData && (officialData.bitrate || officialData.bitRate || 0),
      cover: kugouSizedImage(officialData && (
        officialData.sizable_cover || officialData.album_img || officialData.img || officialData.imgUrl || officialData.image
      ) || cover, 500),
      requestedQuality,
      playbackSource: 'kugou-official-web',
      attempts: [
        compactKugouPlayAttempt('web-playinfo', info),
        compactKugouPlayAttempt('official-web', officialWebInfo),
      ],
    };
  }
  let appInfo = null;
  let v5Info = null;
  try {
    appInfo = await handleKugouAppSongInfo(h, albumId, albumAudioId);
  } catch (e) {
    appInfo = { status: 0, error: e.message };
  }
  try {
    v5Info = await handleKugouV5SongInfo(h, albumId, albumAudioId, requestedQuality);
  } catch (e) {
    v5Info = { status: 0, error: e.message };
  }
  const v5Url = firstKugouPlayableUrl(v5Info && (v5Info.url || v5Info.play_url || v5Info.playUrl || v5Info.play_backup_url || v5Info.backup_url));
  if (v5Url) {
    return {
      provider: 'kugou',
      url: v5Url,
      trial: false,
      playable: true,
      level: requestedQuality,
      quality: v5Info && (v5Info.extName || v5Info.fileExt || v5Info.bitRate || v5Info.bitRate === 0 || v5Info.requestedKugouQuality)
        ? String(v5Info.extName || v5Info.fileExt || v5Info.bitRate || v5Info.requestedKugouQuality)
        : '酷狗客户端音源',
      br: v5Info && (v5Info.bitRate || v5Info.bitrate || 0),
      cover,
      requestedQuality,
      playbackSource: 'kugou-v5',
      attempts: [
        compactKugouPlayAttempt('web-playinfo', info),
        compactKugouPlayAttempt('official-web', officialWebInfo),
        compactKugouPlayAttempt('app-v2', appInfo),
        compactKugouPlayAttempt('app-v5', v5Info),
      ],
    };
  }
  const appUrl = firstKugouPlayableUrl(appInfo && (appInfo.url || appInfo.play_url || appInfo.playUrl || appInfo.play_backup_url || appInfo.backup_url));
  if (appUrl) {
    return {
      provider: 'kugou',
      url: appUrl,
      trial: false,
      playable: true,
      level: requestedQuality,
      quality: appInfo && (appInfo.extName || appInfo.fileExt || appInfo.bitRate || appInfo.bitRate === 0) ? String(appInfo.extName || appInfo.fileExt || appInfo.bitRate) : '酷狗客户端音源',
      br: appInfo && (appInfo.bitRate || appInfo.bitrate || 0),
      cover,
      requestedQuality,
      playbackSource: 'kugou-app',
      attempts: [
        compactKugouPlayAttempt('web-playinfo', info),
        compactKugouPlayAttempt('official-web', officialWebInfo),
        compactKugouPlayAttempt('app-v2', appInfo),
        compactKugouPlayAttempt('app-v5', v5Info),
      ],
    };
  }
  const restrictionInfo = {
    ...(info || {}),
    ...(officialWebInfo || {}),
    ...(appInfo || {}),
    ...(v5Info || {}),
    error: (v5Info && (v5Info.error || v5Info.msg || v5Info.message || v5Info.errmsg)) ||
      (appInfo && (appInfo.error || appInfo.msg || appInfo.message)) ||
      (officialWebInfo && (officialWebInfo.error || officialWebInfo.msg || officialWebInfo.message || officialWebInfo.errmsg)) ||
      (info && (info.error || info.msg || info.message)) || '',
  };
  const restriction = classifyKugouPlaybackRestriction(restrictionInfo);
  return {
    provider: 'kugou',
    url: '',
    playable: false,
    trial: false,
    error: 'KUGOU_URL_UNAVAILABLE',
    reason: restriction.category,
    message: restriction.message,
    restriction,
    cover,
    requestedQuality,
    rawMessage: (v5Info && (v5Info.error || v5Info.msg || v5Info.message || v5Info.errmsg)) ||
      (appInfo && (appInfo.error || appInfo.msg || appInfo.message)) ||
      (officialWebInfo && (officialWebInfo.error || officialWebInfo.msg || officialWebInfo.message || officialWebInfo.errmsg)) ||
      (info && (info.error || info.msg || info.message || '')),
    attempts: [
      compactKugouPlayAttempt('web-playinfo', info),
      compactKugouPlayAttempt('official-web', officialWebInfo),
      compactKugouPlayAttempt('app-v2', appInfo),
      compactKugouPlayAttempt('app-v5', v5Info),
    ],
  };
}

async function handleKugouLyric(hash, keyword, duration) {
  const h = String(hash || '').trim();
  const kw = String(keyword || '').trim();
  const durMs = Math.max(0, Number(duration) || 0);
  const search = await kugouGetJSON(KUGOU_LYRIC_SEARCH_URL, {
    ver: 1,
    man: 'yes',
    client: 'pc',
    keyword: kw,
    duration: durMs,
    hash: h,
  });
  const candidates = search && Array.isArray(search.candidates) ? search.candidates : [];
  const first = candidates[0];
  if (!first || !first.id || !first.accesskey) {
    return { provider: 'kugou', hash: h, lyric: '', source: 'kugou-empty' };
  }
  const data = await kugouGetJSON(KUGOU_LYRIC_DOWNLOAD_URL, {
    ver: 1,
    client: 'pc',
    id: first.id,
    accesskey: first.accesskey,
    fmt: 'lrc',
    charset: 'utf8',
  });
  let lyric = data && (data.content || data.lyric || '');
  if (lyric) {
    const rawLyric = String(lyric).trim();
    if (!/^\[/.test(rawLyric) && /^[A-Za-z0-9+/=\r\n]+$/.test(rawLyric)) {
      try {
        const decoded = Buffer.from(rawLyric, 'base64').toString('utf8');
        if (/\[\d{1,2}:\d{1,2}/.test(decoded) || /^\s*\[[a-z]+:/i.test(decoded)) lyric = decoded;
      } catch (e) {}
    }
  }
  return {
    provider: 'kugou',
    hash: h,
    lyric: lyric || '',
    tlyric: '',
    yrc: '',
    source: lyric ? 'kugou-lyric' : 'kugou-empty',
  };
}

function sodaBaseParams(extra) {
  return {
    aid: '386088',
    device_platform: 'web',
    channel: 'pc_web',
    ...(extra || {}),
  };
}

function sodaAppParams(extra) {
  return {
    aid: '386088',
    app_name: 'luna_pc',
    version_name: '3.0.0',
    version_code: '30000000',
    device_platform: 'windows',
    device_type: 'Windows',
    os_version: 'Windows',
    channel: 'official',
    ac: 'wifi',
    ...(extra || {}),
  };
}

async function sodaGetJSON(targetUrl, params, opts) {
  opts = opts || {};
  const u = new URL(targetUrl);
  Object.keys(params || {}).forEach(k => {
    if (params[k] != null && params[k] !== '') u.searchParams.set(k, String(params[k]));
  });
  const text = await requestText(u.toString(), {
    headers: {
      Referer: 'https://qishui.douyin.com/',
      'User-Agent': SODA_USER_AGENT,
      ...(opts.headers || {}),
    },
  });
  return parseJSONText(text);
}

async function sodaAppJSON(pathOrUrl, params, opts) {
  opts = opts || {};
  const target = /^https?:\/\//i.test(String(pathOrUrl || ''))
    ? String(pathOrUrl)
    : (SODA_APP_API_BASE + '/' + String(pathOrUrl || '').replace(/^\/+/, ''));
  const u = new URL(target);
  const mergedParams = sodaAppParams(params || {});
  Object.keys(mergedParams).forEach(k => {
    if (u.searchParams.has(k)) return;
    if (mergedParams[k] != null && mergedParams[k] !== '') u.searchParams.set(k, String(mergedParams[k]));
  });
  const headers = {
    Accept: 'application/json',
    Referer: 'https://qishui.douyin.com/',
    Origin: 'https://qishui.douyin.com',
    'User-Agent': SODA_APP_USER_AGENT,
    ...(opts.headers || {}),
  };
  if (opts.cookie !== false && sodaCookie) headers.Cookie = sodaCookie;
  const requestOpts = { headers };
  if (opts.method === 'POST') {
    requestOpts.method = 'POST';
    requestOpts.body = JSON.stringify(opts.body || {});
    requestOpts.headers['Content-Type'] = 'application/json';
  }
  const text = await requestText(u.toString(), requestOpts, requestOpts.body);
  return parseJSONText(text);
}

function sodaApiStatusMessage(raw) {
  raw = raw || {};
  const st = raw.status_info || raw.statusInfo || {};
  return raw.status_msg || raw.statusMsg || st.status_msg || st.statusMsg || raw.message || raw.msg || raw.error || '';
}

function sodaSizedImage(img, suffix) {
  img = img || {};
  const urls = Array.isArray(img.urls) ? img.urls : [];
  let base = String(urls[0] || '').trim();
  const uri = String(img.uri || '').trim();
  if (!base) return '';
  if (uri && base.indexOf(uri) < 0) base += uri;
  suffix = suffix || '~c5_375x375.jpg';
  if (suffix && base.indexOf('~') < 0 && !/[?&]x-expires=/.test(base)) base += suffix;
  return base.replace(/^http:\/\//i, 'https://');
}

function mapSodaTrack(track) {
  track = track || {};
  if (track.track) track = track.track;
  if (track.track_info) track = track.track_info;
  if (track.entity && track.entity.track) track = track.entity.track;
  if (track.media && track.media.track) track = track.media.track;
  const artists = Array.isArray(track.artists) ? track.artists : [];
  const artist = artists.length
    ? artists.map(a => a && (a.name || a.simple_display_name)).filter(Boolean).join(' / ')
    : (track.artist || track.artist_name || track.author || track.singer || '');
  const album = track.album || {};
  const labelInfo = track.label_info || track.labelInfo || {};
  const qualityMap = labelInfo.quality_map || labelInfo.qualityMap || {};
  const vipQualities = Array.isArray(labelInfo.quality_only_vip_can_play) ? labelInfo.quality_only_vip_can_play : [];
  const cover = sodaSizedImage(album.url_cover || track.url_cover || track.urlCover || track.cover || track.cover_url || track.pic_url || track.image, '~c5_375x375.jpg') ||
    String(track.cover || track.cover_url || track.pic_url || track.image || '');
  const id = String(track.id || track.track_id || track.trackId || track.item_id || track.media_id || '').trim();
  const duration = Number(track.duration || track.duration_ms || 0) || 0;
  return {
    provider: 'soda',
    source: 'soda',
    type: 'soda',
    id,
    trackId: id,
    vid: track.vid || '',
    previewVid: track.preview && track.preview.vid || '',
    name: track.name || track.title || '',
    artist,
    artists: artists.map(a => ({ id: a && a.id || '', name: a && (a.name || a.simple_display_name) || '' })).filter(a => a.name),
    album: album.name || '',
    albumId: album.id || '',
    cover,
    duration,
    fee: vipQualities.length || (qualityMap.lossless && qualityMap.lossless.play_detail && qualityMap.lossless.play_detail.need_vip) ? 1 : 0,
    playable: true,
  };
}

function looksLikeSodaTrack(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const id = raw.id || raw.track_id || raw.trackId || raw.item_id || raw.media_id;
  const name = raw.name || raw.title;
  return !!(id && name);
}

function collectSodaTracks(raw, out, depth) {
  out = out || [];
  depth = depth || 0;
  if (!raw || depth > 7 || out.length >= 240) return out;
  if (Array.isArray(raw)) {
    raw.forEach(item => collectSodaTracks(item, out, depth + 1));
    return out;
  }
  if (typeof raw !== 'object') return out;
  const candidate = raw.track || raw.track_info || raw.trackInfo || (raw.entity && raw.entity.track) || (raw.media && raw.media.track) || raw;
  if (looksLikeSodaTrack(candidate)) {
    const song = mapSodaTrack(candidate);
    if (song && song.id && song.name && !out.some(item => item.id === song.id)) out.push(song);
  }
  [
    raw.tracks, raw.track_list, raw.trackList, raw.songs, raw.song_list, raw.songList,
    raw.items, raw.list, raw.data, raw.cards, raw.medias, raw.media_list, raw.mediaList,
    raw.playlist, raw.collection, raw.result, raw.results, raw.recently_played_media,
  ].forEach(value => collectSodaTracks(value, out, depth + 1));
  return out;
}

function normalizeSodaProfile(raw, cookieObj) {
  cookieObj = cookieObj || sodaCookieObject();
  const root = raw && (raw.data || raw.user || raw.profile || raw.me || raw.account || raw) || {};
  const user = root.user || root.profile || root.account || root;
  const userId = String(user.user_id || user.userId || user.uid || user.id || sodaCookieUserId(cookieObj) || '').trim();
  const nickname = user.nickname || user.nick_name || user.name || user.screen_name || sodaCookieValue(cookieObj, ['nickname', 'nick_name', 'name']) || '';
  const avatarObj = user.avatar || user.avatar_url || user.url_avatar || user.cover || {};
  const avatar = typeof avatarObj === 'string'
    ? avatarObj
    : ((Array.isArray(avatarObj.urls) && avatarObj.urls[0]) || avatarObj.url || avatarObj.uri || '');
  return {
    provider: 'soda',
    loggedIn: !!(userId || sodaCookieHasLogin()),
    preview: false,
    userId,
    nickname: nickname || (userId ? ('汽水用户 ' + userId) : '汽水音乐'),
    avatar: avatar ? String(avatar).replace(/^http:\/\//i, 'https://') : '',
    hasCookie: !!sodaCookie,
    playlistReady: !!sodaCookie,
    profileSource: userId || nickname || avatar ? 'soda-profile' : 'cookie',
  };
}

async function getSodaLoginInfo() {
  if (!sodaCookie) return { provider: 'soda', loggedIn: false, hasCookie: false, playlistReady: false };
  const cookieObj = sodaCookieObject();
  const fallback = normalizeSodaProfile(null, cookieObj);
  if (!sodaCookieHasLogin()) return { ...fallback, loggedIn: false, hasCookie: true, playlistReady: false };
  try {
    const data = await sodaAppJSON('me', {}, { cookie: true });
    const code = Number(data && data.status_code || 0);
    if (code === 1000016) return { ...fallback, loggedIn: false, stale: true, message: sodaApiStatusMessage(data), playlistReady: false };
    const info = normalizeSodaProfile(data, cookieObj);
    return { ...fallback, ...info, loggedIn: true, profileRawCode: code || undefined };
  } catch (e) {
    console.warn('[SodaLogin] profile check failed:', e.message);
    return { ...fallback, loggedIn: true, profileUnavailable: true };
  }
}

async function fetchSodaBuiltinTracks(kind, limit) {
  const max = Math.max(1, Math.min(100, parseInt(limit || '50', 10) || 50));
  const attempts = [];
  const candidates = kind === 'recent'
    ? [
        { path: 'me/recently-played-media', params: { count: max, cursor: 0 }, method: 'GET' },
      ]
    : [
        { path: 'feed/song-tab', params: {}, method: 'POST', body: { cursor: 0, count: max } },
      ];
  for (const item of candidates) {
    try {
      const data = await sodaAppJSON(item.path, item.params, { method: item.method, body: item.body, cookie: true });
      const code = Number(data && data.status_code || 0);
      const msg = sodaApiStatusMessage(data);
      attempts.push({ path: item.path, code, message: msg });
      if (code === 1000016) return { loggedIn: false, stale: true, tracks: [], attempts, error: msg || 'SODA_LOGIN_REQUIRED' };
      if (code && code !== 0 && code !== 200) continue;
      const tracks = collectSodaTracks(data, []).slice(0, max);
      if (tracks.length) return { loggedIn: true, tracks, attempts };
    } catch (e) {
      attempts.push({ path: item.path, error: e.message });
    }
  }
  return { loggedIn: true, tracks: [], attempts, error: attempts.map(a => a.message || a.error).filter(Boolean).join('; ') || '' };
}

async function handleSodaUserPlaylists() {
  const info = await getSodaLoginInfo();
  if (!info.loggedIn) return { loggedIn: false, provider: 'soda', playlists: [], stale: !!info.stale, message: info.message || '' };
  return {
    loggedIn: true,
    provider: 'soda',
    userId: info.userId || '',
    playlists: [
      { provider: 'soda', source: 'soda', id: 'soda:liked', name: '汽水收藏 / 喜欢', cover: info.avatar || '', trackCount: 0, creator: info.nickname || '汽水音乐', subscribed: false, kind: 'liked' },
      { provider: 'soda', source: 'soda', id: 'soda:recent', name: '汽水最近播放', cover: info.avatar || '', trackCount: 0, creator: info.nickname || '汽水音乐', subscribed: false, kind: 'recent' },
    ],
  };
}

async function handleSodaPlaylistTracks(id, limit) {
  const info = await getSodaLoginInfo();
  if (!info.loggedIn) return { loggedIn: false, provider: 'soda', tracks: [], stale: !!info.stale, error: info.message || 'SODA_LOGIN_REQUIRED' };
  const key = String(id || '').toLowerCase();
  const kind = key.indexOf('recent') >= 0 ? 'recent' : 'liked';
  const result = await fetchSodaBuiltinTracks(kind, limit);
  return {
    provider: 'soda',
    loggedIn: !!result.loggedIn,
    playlist: { id: kind === 'recent' ? 'soda:recent' : 'soda:liked', name: kind === 'recent' ? '汽水最近播放' : '汽水收藏 / 喜欢', trackCount: result.tracks.length },
    tracks: result.tracks || [],
    stale: !!result.stale,
    error: result.error || '',
    attempts: result.attempts || [],
  };
}

async function handleSodaSearch(keywords, limit) {
  const kw = String(keywords || '').trim();
  if (!kw) return [];
  const json = await sodaGetJSON(SODA_SEARCH_URL, sodaBaseParams({
    q: kw,
    cursor: '0',
    search_method: 'input',
  }));
  const groups = Array.isArray(json.result_groups) ? json.result_groups : [];
  const data = groups[0] && Array.isArray(groups[0].data) ? groups[0].data : [];
  const max = Math.max(1, Math.min(24, parseInt(limit || '12', 10) || 12));
  const seen = new Set();
  return data.map(item => mapSodaTrack(item && item.entity && item.entity.track || {})).filter(song => {
    const key = song && (song.id || (song.name + '|' + song.artist));
    if (!song || !song.name || !key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, max);
}

async function handleSodaTrackV2(trackId) {
  const id = String(trackId || '').trim();
  if (!id) throw new Error('SODA_TRACK_ID_REQUIRED');
  return sodaGetJSON(SODA_TRACK_V2_URL, sodaBaseParams({
    track_id: id,
    media_type: 'track',
  }));
}

function sodaTrackDurationMs(track) {
  return Number(track && (track.duration || track.duration_ms || 0)) || 0;
}

function sodaQualityRank(quality) {
  const q = String(quality || '').toLowerCase();
  if (/jymaster|master|lossless|hi_res|hires|spatial/.test(q)) return 600;
  if (/highest/.test(q)) return 500;
  if (/higher/.test(q)) return 400;
  if (/medium/.test(q)) return 300;
  return 100;
}

function sodaDesiredQualityRank(qualityPreference) {
  const q = normalizeQualityPreference(qualityPreference);
  if (q === 'jymaster' || q === 'lossless' || q === 'hires') return 600;
  if (q === 'exhigh') return 500;
  if (q === 'standard') return 300;
  return 400;
}

function firstSodaPlayUrl(info) {
  return String((info && (info.MainPlayUrl || info.main_play_url || info.main_url || info.url || info.play_url)) ||
    (info && (info.BackupPlayUrl || info.backup_play_url || info.backup_url)) || '').trim();
}

function chooseSodaPlayInfo(list, fullDurationMs, qualityPreference) {
  list = Array.isArray(list) ? list : [];
  const fullThreshold = fullDurationMs > 0 ? Math.max(25000, fullDurationMs * 0.82) : 0;
  const desiredRank = sodaDesiredQualityRank(qualityPreference);
  const candidates = list.map(item => {
    const durationMs = (Number(item.Duration || item.duration || 0) || 0) * 1000;
    const quality = item.Quality || item.quality || '';
    const url = firstSodaPlayUrl(item);
    return {
      raw: item,
      url,
      durationMs,
      quality,
      full: !fullThreshold || durationMs >= fullThreshold || Math.abs(durationMs - fullDurationMs) <= 2500,
      rank: sodaQualityRank(quality),
      distance: Math.abs(sodaQualityRank(quality) - desiredRank),
    };
  }).filter(item => item.url);
  candidates.sort((a, b) => {
    if (a.full !== b.full) return a.full ? -1 : 1;
    if (a.distance !== b.distance) return a.distance - b.distance;
    return b.rank - a.rank;
  });
  return candidates[0] || null;
}

function sodaPlayAuthKey(playAuth) {
  const data = Buffer.from(String(playAuth || ''), 'base64');
  if (data.length < 3) throw new Error('SODA_INVALID_PLAY_AUTH');
  const paddingLen = (data[0] ^ data[1] ^ data[2]) - 48;
  if (paddingLen < 0 || data.length < paddingLen + 2) throw new Error('SODA_INVALID_PLAY_AUTH_PADDING');
  const inner = data.subarray(1, data.length - paddingLen);
  const tmp = Buffer.alloc(inner.length);
  const buff = Buffer.concat([Buffer.from([0xfa, 0x55]), inner]);
  for (let i = 0; i < tmp.length; i++) {
    let v = (inner[i] ^ buff[i]) - bitCount32(i) - 21;
    while (v < 0) v += 255;
    tmp[i] = v & 0xff;
  }
  const skip = decodeBase36Byte(tmp[0]);
  const end = 1 + (data.length - paddingLen - 2) - skip;
  if (end > tmp.length || end < 1) throw new Error('SODA_INVALID_PLAY_AUTH_INDEX');
  return tmp.subarray(1, end).toString('utf8');
}

function bitCount32(n) {
  let u = n >>> 0;
  u = u - ((u >>> 1) & 0x55555555);
  u = (u & 0x33333333) + ((u >>> 2) & 0x33333333);
  return (((u + (u >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function decodeBase36Byte(byte) {
  if (byte >= 48 && byte <= 57) return byte - 48;
  if (byte >= 97 && byte <= 122) return byte - 97 + 10;
  if (byte >= 65 && byte <= 90) return byte - 65 + 10;
  return 0xff;
}

async function resolveSodaPlayableInfo(trackId, qualityPreference) {
  const trackV2 = await handleSodaTrackV2(trackId);
  const track = trackV2.track || {};
  const fullDurationMs = sodaTrackDurationMs(track);
  const player = trackV2.track_player || {};
  if (!player.url_player_info) {
    const err = new Error('SODA_PLAYER_INFO_MISSING');
    err.category = 'url_unavailable';
    throw err;
  }
  const playInfoJson = await sodaGetJSON(player.url_player_info, {}, { headers: { Referer: 'https://qishui.douyin.com/' } });
  const playInfoList = playInfoJson && playInfoJson.Result && playInfoJson.Result.Data && playInfoJson.Result.Data.PlayInfoList || [];
  const chosen = chooseSodaPlayInfo(playInfoList, fullDurationMs, qualityPreference);
  if (!chosen || !chosen.url) {
    const err = new Error('SODA_PLAY_URL_MISSING');
    err.category = 'url_unavailable';
    throw err;
  }
  if (!chosen.full) {
    const err = new Error('SODA_TRIAL_ONLY');
    err.category = 'trial_only';
    err.durationMs = chosen.durationMs;
    err.fullDurationMs = fullDurationMs;
    throw err;
  }
  const auth = chosen.raw.PlayAuth || chosen.raw.play_auth || '';
  const encryption = String(chosen.raw.EncryptionMethod || chosen.raw.encryption_method || '').toLowerCase();
  return {
    track,
    url: chosen.url,
    playAuth: auth,
    decryptKey: auth ? sodaPlayAuthKey(auth) : '',
    encrypted: !!auth || /cenc|aes|ctr/.test(encryption),
    quality: chosen.quality || '',
    br: Number(chosen.raw.Bitrate || chosen.raw.bitrate || 0) || 0,
    size: Number(chosen.raw.Size || chosen.raw.size || 0) || 0,
    durationMs: chosen.durationMs || fullDurationMs,
    fullDurationMs,
    format: chosen.raw.Format || chosen.raw.format || 'm4a',
  };
}

async function handleSodaSongUrl(trackId, qualityPreference) {
  const id = String(trackId || '').trim();
  if (!id) return { provider: 'soda', url: '', playable: false, error: 'SODA_TRACK_ID_REQUIRED', message: 'Missing Soda track id' };
  try {
    const info = await resolveSodaPlayableInfo(id, qualityPreference);
    return {
      provider: 'soda',
      url: info.encrypted
        ? ('/api/soda/audio?id=' + encodeURIComponent(id) + '&quality=' + encodeURIComponent(qualityPreference || ''))
        : info.url,
      playable: true,
      trial: false,
      level: normalizeQualityPreference(qualityPreference),
      quality: info.quality || 'soda',
      br: info.br,
      size: info.size,
      duration: info.durationMs,
      encrypted: info.encrypted,
      playbackSource: info.encrypted ? 'soda-buffer' : 'soda-direct',
    };
  } catch (err) {
    const category = err.category || (/trial/i.test(err.message) ? 'trial_only' : 'url_unavailable');
    const message = category === 'trial_only'
      ? '汽水音乐当前只返回试听片段'
      : '汽水音乐没有返回可播放的全长音频';
    const restriction = playbackRestriction('soda', category, message, 'switch_source', {
      rawMessage: err.message,
      durationMs: err.durationMs || 0,
      fullDurationMs: err.fullDurationMs || 0,
    });
    return {
      provider: 'soda',
      url: '',
      playable: false,
      trial: category === 'trial_only',
      error: err.message,
      reason: category,
      message,
      restriction,
    };
  }
}

function parseSodaLyric(raw) {
  return String(raw || '').split(/\r?\n/).map(line => {
    const m = String(line || '').trim().match(/^\[(\d+),(\d+)\](.*)$/);
    if (!m) return '';
    const start = parseInt(m[1], 10) || 0;
    const content = String(m[3] || '').replace(/<[^>]+>/g, '');
    const min = Math.floor(start / 60000);
    const sec = Math.floor((start % 60000) / 1000);
    const cs = Math.floor((start % 1000) / 10);
    return '[' + String(min).padStart(2, '0') + ':' + String(sec).padStart(2, '0') + '.' + String(cs).padStart(2, '0') + ']' + content;
  }).filter(Boolean).join('\n');
}

async function handleSodaLyric(trackId) {
  const data = await handleSodaTrackV2(trackId);
  const raw = data && data.lyric && data.lyric.content || '';
  return { provider: 'soda', id: String(trackId || ''), lyric: parseSodaLyric(raw), tlyric: '', yrc: '', source: raw ? 'soda-lyric' : 'soda-empty' };
}

function sodaAudioCacheKey(trackId, qualityPreference) {
  return String(trackId || '').trim() + '|' + normalizeQualityPreference(qualityPreference || '');
}

function pruneSodaAudioCache() {
  const now = Date.now();
  for (const [key, entry] of sodaAudioCache) {
    if (!entry || now - entry.createdAt > SODA_AUDIO_CACHE_TTL_MS) {
      sodaAudioCache.delete(key);
      sodaAudioCacheBytes -= entry && entry.size || 0;
    }
  }
  while (sodaAudioCache.size > SODA_AUDIO_CACHE_MAX_ENTRIES || sodaAudioCacheBytes > SODA_AUDIO_CACHE_MAX_BYTES) {
    const firstKey = sodaAudioCache.keys().next().value;
    if (!firstKey) break;
    const entry = sodaAudioCache.get(firstKey);
    sodaAudioCache.delete(firstKey);
    sodaAudioCacheBytes -= entry && entry.size || 0;
  }
  if (sodaAudioCacheBytes < 0) sodaAudioCacheBytes = 0;
}

function getSodaAudioCache(key) {
  pruneSodaAudioCache();
  const entry = sodaAudioCache.get(key);
  if (!entry) return null;
  sodaAudioCache.delete(key);
  entry.touchedAt = Date.now();
  sodaAudioCache.set(key, entry);
  return entry;
}

function setSodaAudioCache(key, entry) {
  if (!entry || !entry.buffer || entry.size > SODA_AUDIO_CACHE_MAX_BYTES) return entry;
  const old = sodaAudioCache.get(key);
  if (old) sodaAudioCacheBytes -= old.size || 0;
  sodaAudioCache.set(key, entry);
  sodaAudioCacheBytes += entry.size || 0;
  pruneSodaAudioCache();
  return entry;
}

function sodaAudioCandidateQualities(qualityPreference) {
  const candidates = [];
  [qualityPreference, normalizeQualityPreference(qualityPreference), 'exhigh', 'standard'].forEach(q => {
    q = String(q || '').trim();
    if (q && !candidates.includes(q)) candidates.push(q);
  });
  if (!candidates.length) candidates.push('hires', 'exhigh', 'standard');
  return candidates;
}

async function fetchSodaDirectAudioBuffer(info) {
  const up = await fetch(info.url, { headers: { 'User-Agent': SODA_USER_AGENT, Referer: 'https://qishui.douyin.com/' } });
  if (!up.ok) throw new Error('SODA_DIRECT_AUDIO_HTTP_' + up.status);
  const buffer = Buffer.from(await up.arrayBuffer());
  if (!buffer.length) throw new Error('SODA_DIRECT_AUDIO_EMPTY');
  if (buffer.length > SODA_AUDIO_BUFFER_MAX_BYTES) throw new Error('SODA_AUDIO_TOO_LARGE');
  return {
    buffer,
    contentType: audioContentTypeForUrl(info.url, up.headers.get('content-type')),
  };
}

function decryptSodaAudioBuffer(info) {
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG_BIN, [
    '-hide_banner',
    '-loglevel', 'error',
    '-decryption_key', info.decryptKey,
    '-i', info.url,
    '-vn',
    '-c:a', 'libmp3lame',
    '-b:a', '192k',
    '-f', 'mp3',
    'pipe:1',
    ], { windowsHide: true });
    const chunks = [];
    let total = 0;
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { if (!ff.killed) ff.kill('SIGKILL'); } catch (e) {}
      reject(new Error('SODA_FFMPEG_TIMEOUT'));
    }, 90000);
    ff.stdout.on('data', chunk => {
      total += chunk.length;
      if (total > SODA_AUDIO_BUFFER_MAX_BYTES) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try { if (!ff.killed) ff.kill('SIGKILL'); } catch (e) {}
          reject(new Error('SODA_AUDIO_TOO_LARGE'));
        }
        return;
      }
      chunks.push(chunk);
    });
    ff.stderr.on('data', d => {
      stderr += d.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    ff.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    ff.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 || !total) {
        const err = new Error('SODA_FFMPEG_FAILED_' + code);
        err.detail = stderr.trim();
        reject(err);
        return;
      }
      resolve({
        buffer: Buffer.concat(chunks, total),
        contentType: 'audio/mpeg',
      });
    });
  });
}

async function buildSodaAudioEntry(trackId, qualityPreference) {
  const info = await resolveSodaPlayableInfo(trackId, qualityPreference);
  const audio = info.encrypted
    ? await decryptSodaAudioBuffer(info)
    : await fetchSodaDirectAudioBuffer(info);
  return {
    buffer: audio.buffer,
    contentType: audio.contentType || 'audio/mp4',
    size: audio.buffer.length,
    info,
    requestedQuality: String(qualityPreference || ''),
    actualQuality: info.quality || '',
    createdAt: Date.now(),
    touchedAt: Date.now(),
  };
}

async function buildSodaAudioEntryWithFallback(trackId, qualityPreference) {
  let lastErr = null;
  for (const candidate of sodaAudioCandidateQualities(qualityPreference)) {
    try {
      const entry = await buildSodaAudioEntry(trackId, candidate);
      entry.actualQualityPreference = candidate;
      return entry;
    } catch (err) {
      lastErr = err;
      if (err && err.category === 'trial_only') continue;
    }
  }
  throw lastErr || new Error('SODA_AUDIO_BUILD_FAILED');
}

async function getSodaAudioEntry(trackId, qualityPreference) {
  const key = sodaAudioCacheKey(trackId, qualityPreference);
  const cached = getSodaAudioCache(key);
  if (cached) return cached;
  if (sodaAudioInflight.has(key)) return sodaAudioInflight.get(key);
  const pending = buildSodaAudioEntryWithFallback(trackId, qualityPreference).then(entry => {
    setSodaAudioCache(key, entry);
    const actualKey = sodaAudioCacheKey(trackId, entry.actualQualityPreference || qualityPreference);
    if (actualKey !== key) setSodaAudioCache(actualKey, entry);
    return entry;
  }).finally(() => {
    sodaAudioInflight.delete(key);
  });
  sodaAudioInflight.set(key, pending);
  return pending;
}

function parseAudioRange(rangeHeader, total) {
  const m = String(rangeHeader || '').trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  let start;
  let end;
  if (!m[1] && !m[2]) return null;
  if (!m[1]) {
    const suffix = parseInt(m[2], 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return { unsatisfiable: true };
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] ? parseInt(m[2], 10) : total - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= total || end < start) {
      return { unsatisfiable: true };
    }
    end = Math.min(end, total - 1);
  }
  return { start, end };
}

function sendSodaAudioBuffer(req, res, entry) {
  const buffer = entry.buffer;
  const total = buffer.length;
  const baseHeaders = {
    'Content-Type': entry.contentType || 'audio/mp4',
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Soda-Audio-Source': 'buffer',
  };
  if (entry.actualQuality) baseHeaders['X-Soda-Quality'] = String(entry.actualQuality);
  const range = parseAudioRange(req.headers.range || '', total);
  if (range && range.unsatisfiable) {
    res.writeHead(416, { ...baseHeaders, 'Content-Range': 'bytes */' + total });
    res.end();
    return;
  }
  if (range) {
    const chunk = buffer.subarray(range.start, range.end + 1);
    res.writeHead(206, {
      ...baseHeaders,
      'Content-Length': chunk.length,
      'Content-Range': 'bytes ' + range.start + '-' + range.end + '/' + total,
    });
    if (req.method === 'HEAD') res.end();
    else res.end(chunk);
    return;
  }
  res.writeHead(200, {
    ...baseHeaders,
    'Content-Length': total,
  });
  if (req.method === 'HEAD') res.end();
  else res.end(buffer);
}

async function streamSodaAudio(req, res, trackId, qualityPreference) {
  try {
    const entry = await getSodaAudioEntry(trackId, qualityPreference);
    sendSodaAudioBuffer(req, res, entry);
  } catch (err) {
    if (!res.headersSent) {
      sendJSON(res, { provider: 'soda', error: err.message, detail: err.detail || '', playable: false }, 500);
      return;
    }
    res.end();
  }
}

async function handleQQSongUrl(mid, mediaMid, qualityPreference) {
  const songmid = String(mid || '').trim();
  if (!songmid) return { provider: 'qq', url: '', error: 'MISSING_MID', message: 'Missing QQ song mid' };
  const guid = String(10000000 + Math.floor(Math.random() * 90000000));
  const cookieObj = qqCookieObject();
  const uin = qqCookieUin(cookieObj) || '0';
  const musicKey = qqCookieMusicKey(cookieObj);
  const playbackKey = qqCookiePlaybackKey(cookieObj);
  const fileMediaMid = String(mediaMid || '').trim();
  const requestedQuality = normalizeQualityPreference(qualityPreference);
  const mediaIds = [];
  if (fileMediaMid) mediaIds.push(fileMediaMid);
  if (songmid && !mediaIds.includes(songmid)) mediaIds.push(songmid);
  const fileCandidates = mediaIds.flatMap(mediaId =>
    qualityCandidatesFrom(requestedQuality, QQ_QUALITY_CANDIDATE_TEMPLATES)
      .map(item => ({ ...item, mediaId, filename: item.prefix + mediaId + item.ext }))
  );
  const filenames = fileCandidates.map(item => item.filename);
  const param = {
    guid,
    songmid: filenames.length ? filenames.map(() => songmid) : [songmid],
    songtype: filenames.length ? filenames.map(() => 0) : [0],
    uin,
    loginflag: 1,
    platform: '20',
  };
  if (filenames.length) param.filename = filenames;
  const comm = { uin, format: 'json', ct: musicKey ? 19 : 24, cv: 0 };
  if (musicKey) comm.authst = musicKey;
  const json = await qqMusicRequest({
    comm,
    req_0: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param,
    },
  }, { cookie: true });
  const data = json && json.req_0 && json.req_0.data;
  const infos = (data && Array.isArray(data.midurlinfo)) ? data.midurlinfo : [];
  const info = infos.find(item => item && item.purl) || infos[0];
  const purl = info && info.purl;
  if (purl) {
    const sip = (data.sip && data.sip[0]) || 'https://ws.stream.qqmusic.qq.com/';
    const fileMeta = fileCandidates.find(item => item.filename === info.filename) || {};
    return {
      provider: 'qq',
      url: sip + purl,
      trial: false,
      playable: true,
      level: fileMeta.level || info.filename || '',
      quality: fileMeta.label || info.filename || '',
      filename: info.filename || '',
      requestedQuality,
    };
  }
  const restriction = classifyQQPlaybackRestriction(info, {
    hasSession: !!(uin && musicKey),
    hasPlaybackKey: !!(uin && playbackKey),
  });
  return {
    provider: 'qq',
    url: '',
    playable: false,
    error: 'QQ_URL_UNAVAILABLE',
    loggedIn: !!(uin && musicKey),
    playbackKeyReady: !!(uin && playbackKey),
    restriction,
    reason: restriction.category,
    message: restriction.message,
    qqCode: info && (info.result || info.code || info.errtype),
    rawMessage: info && (info.msg || info.tips || info.errmsg || ''),
    tried: fileCandidates.map(item => item.label + ' · ' + item.filename),
    requestedQuality,
  };
}

function mapQQComment(raw) {
  raw = raw || {};
  const user = raw.user || raw.uin || {};
  const nickname = raw.nick || raw.nickname || raw.encrypt_uin || user.nick || user.nickname || user.name || 'QQ 音乐用户';
  const avatar = raw.avatarurl || raw.avatar || user.avatarurl || user.avatar || '';
  const timeRaw = Number(raw.time || raw.commenttime || raw.createTime || 0) || 0;
  return {
    id: raw.commentid || raw.commentId || raw.id || '',
    content: raw.rootcommentcontent || raw.content || raw.comment || '',
    likedCount: Number(raw.praisenum || raw.praise_num || raw.likedCount || 0) || 0,
    time: timeRaw && timeRaw < 10000000000 ? timeRaw * 1000 : timeRaw,
    user: {
      id: raw.encrypt_uin || raw.uin || user.uin || '',
      nickname,
      avatar,
    },
  };
}

async function handleQQSongComments(id, mid, limit, offset) {
  let topid = String(id || '').replace(/\D/g, '');
  if (!topid && mid) {
    try {
      const detail = await qqSongDetail(mid, { mid });
      topid = String((detail && (detail.qqId || detail.id)) || '').replace(/\D/g, '');
    } catch (e) {
      console.warn('[QQComments] detail fallback failed:', e.message);
    }
  }
  if (!topid) return { provider: 'qq', error: 'Missing QQ song id', comments: [] };
  const page = Math.max(0, Math.floor((offset || 0) / Math.max(1, limit || 20)));
  const uin = qqCookieUin() || '0';
  const body = await qqGetJSON('https://c.y.qq.com/base/fcgi-bin/fcg_global_comment_h5.fcg', {
    g_tk: '5381',
    loginUin: uin,
    hostUin: '0',
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    notice: '0',
    platform: 'yqq.json',
    needNewCode: '0',
    cid: '205360772',
    reqtype: '2',
    biztype: '1',
    topid,
    cmd: '8',
    needmusiccrit: '0',
    pagenum: String(page),
    pagesize: String(limit || 20),
  }, { headers: { Referer: 'https://y.qq.com/n/ryqq/songDetail/' + encodeURIComponent(mid || topid) } });
  const hotList = body && body.hot_comment && body.hot_comment.commentlist;
  const normalList = body && body.comment && body.comment.commentlist;
  const raw = (offset === 0 && Array.isArray(hotList) && hotList.length) ? hotList : (normalList || []);
  const comments = (raw || []).map(mapQQComment).filter(c => c.content);
  const total = Number(body && body.comment && (body.comment.commenttotal || body.comment.comment_total)) || comments.length;
  return { provider: 'qq', id: topid, total, comments, hot: !!(offset === 0 && Array.isArray(hotList) && hotList.length) };
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
}

function decodeQQLyricText(text) {
  let raw = decodeHtmlEntities(String(text || '').trim());
  if (!raw) return '';
  const compact = raw.replace(/\s+/g, '');
  const looksBase64 = compact.length >= 8 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
  if (looksBase64 && !/^\s*\[/.test(raw)) {
    try {
      const decoded = Buffer.from(compact, 'base64').toString('utf8').replace(/^\uFEFF/, '');
      if (decoded && (decoded.includes('[') || /[\u4e00-\u9fa5]/.test(decoded))) raw = decoded;
    } catch (e) {
      console.warn('[QQLyric] base64 decode failed:', e.message);
    }
  }
  return decodeHtmlEntities(raw).replace(/\r\n/g, '\n').trim();
}

function normalizeQQSongId(id) {
  const n = String(id || '').replace(/\D/g, '');
  return n ? Number(n) : 0;
}

async function handleQQLyric(mid, id) {
  const songMID = String(mid || '').trim();
  const songID = normalizeQQSongId(id);
  if (!songMID && !songID) return { provider: 'qq', error: 'Missing QQ song mid or id', lyric: '' };

  let lyricText = '';
  let transText = '';
  let qrcText = '';
  let romaText = '';
  let source = 'qq-musicu';

  try {
    const param = {};
    if (songMID) param.songMID = songMID;
    if (songID) param.songID = songID;
    const json = await qqMusicRequest({
      comm: { ct: 24, cv: 0 },
      lyric: {
        module: 'music.musichallSong.PlayLyricInfo',
        method: 'GetPlayLyricInfo',
        param,
      },
    }, { cookie: true });
    const data = json && json.lyric && json.lyric.data;
    lyricText = decodeQQLyricText(data && data.lyric);
    transText = decodeQQLyricText(data && data.trans);
    qrcText = decodeQQLyricText(data && data.qrc);
    romaText = decodeQQLyricText(data && data.roma);
  } catch (e) {
    console.warn('[QQLyric] musicu failed:', e.message);
  }

  if (!lyricText && songMID) {
    try {
      const body = await qqGetJSON('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg', {
        songmid: songMID,
        songtype: '0',
        format: 'json',
        nobase64: '1',
        g_tk: '5381',
        loginUin: qqCookieUin() || '0',
        hostUin: '0',
        inCharset: 'utf8',
        outCharset: 'utf-8',
        notice: '0',
        platform: 'yqq.json',
        needNewCode: '0',
      }, { headers: { Referer: 'https://y.qq.com/portal/player.html' } });
      lyricText = decodeQQLyricText(body && body.lyric);
      transText = decodeQQLyricText(body && (body.trans || body.tlyric)) || transText;
      source = 'qq-legacy';
    } catch (e) {
      console.warn('[QQLyric] legacy failed:', e.message);
    }
  }

  return {
    provider: 'qq',
    id: songID || '',
    mid: songMID,
    lyric: lyricText,
    tlyric: transText,
    yrc: '',
    qrc: qrcText,
    roma: romaText,
    source: lyricText ? source : 'qq-empty',
  };
}

function mapPodcastRadio(r) {
  r = r || {};
  const dj = r.dj || r.djSimple || r.djUser || r.creator || {};
  const id = r.id || r.rid || r.radioId;
  return {
    id,
    rid: id,
    name: r.name || r.radioName || '',
    cover: r.picUrl || r.picURL || r.coverUrl || r.coverImgUrl || r.avatarUrl || '',
    desc: r.desc || r.description || r.rcmdText || '',
    djName: dj.nickname || r.djName || r.nickname || '',
    category: r.category || r.categoryName || '',
    programCount: r.programCount || r.programNum || r.programCnt || 0,
    subCount: r.subCount || r.subedCount || r.subscriberCount || 0,
  };
}

function mapPodcastProgram(p, fallbackRadio) {
  p = p || {};
  const mainSong = p.mainSong || p.song || p.mainTrack || {};
  const radio = p.radio || fallbackRadio || {};
  const mappedRadio = mapPodcastRadio(radio);
  const artists = mapArtists(mainSong.ar || mainSong.artists || []);
  const album = mainSong.al || mainSong.album || {};
  const dj = p.dj || radio.dj || {};
  const playableId = mainSong.id || p.mainSongId || p.songId;
  return {
    type: 'podcast',
    source: 'podcast',
    id: playableId,
    programId: p.id || p.programId,
    radioId: mappedRadio.id,
    name: p.name || mainSong.name || '',
    artist: mappedRadio.name || dj.nickname || artists.map(a => a.name).join(' / ') || mappedRadio.djName || '',
    artists,
    artistId: artists[0] && artists[0].id,
    album: mappedRadio.name || album.name || 'Podcast',
    cover: p.coverUrl || p.cover || p.blurCoverUrl || mappedRadio.cover || album.picUrl || '',
    duration: p.duration || mainSong.dt || mainSong.duration || 0,
    fee: mainSong.fee,
    djName: mappedRadio.djName || dj.nickname || '',
    radioName: mappedRadio.name || '',
    desc: p.description || p.desc || '',
    createTime: p.createTime || 0,
    serialNum: p.serialNum || p.serial || 0,
  };
}

function firstArrayFrom(obj, keys) {
  obj = obj || {};
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.list)) return value.list;
    if (value && Array.isArray(value.data)) return value.data;
    if (value && Array.isArray(value.resources)) return value.resources;
  }
  return [];
}

function mapPodcastVoice(v) {
  v = v || {};
  const raw = v.resource || v.voice || v.data || v.program || v;
  const mainSong = raw.mainSong || raw.song || raw.track || {};
  const radio = raw.radio || raw.djRadio || raw.voiceList || raw.podcast || {};
  const playableId = raw.trackId || raw.songId || raw.mainSongId || mainSong.id || raw.id;
  return {
    type: 'podcast',
    source: 'podcast',
    sourceType: 'podcast-voice',
    id: playableId,
    programId: raw.programId || raw.voiceId || raw.id,
    radioId: radio.id || radio.radioId || radio.voiceListId || raw.radioId || raw.voiceListId,
    name: raw.name || raw.songName || raw.title || mainSong.name || '',
    artist: (radio.name || radio.radioName || radio.voiceListName || raw.podcastName || raw.djName || 'Voice'),
    album: radio.name || radio.radioName || raw.podcastName || 'Podcast',
    cover: raw.coverUrl || raw.cover || raw.picUrl || raw.coverImgUrl || radio.picUrl || radio.coverUrl || '',
    duration: raw.duration || raw.durationMs || mainSong.dt || mainSong.duration || 0,
    djName: raw.djName || (radio.dj && radio.dj.nickname) || '',
    radioName: radio.name || radio.radioName || raw.podcastName || '',
    desc: raw.desc || raw.description || '',
  };
}

function mapPodcastCollectionRadio(r, key) {
  const radio = mapPodcastRadio(r);
  return {
    ...radio,
    type: 'podcast-radio',
    sourceType: 'podcast-radio',
    collectionKey: key || '',
    radioId: radio.id,
    name: radio.name,
    artist: radio.djName || radio.category || 'Podcast',
    album: radio.category || 'Podcast',
  };
}

function podcastCollectionMeta(key, items) {
  const meta = {
    collect: { key: 'collect', title: '收藏播客', sub: '你收藏的播客', itemType: 'radio' },
    created: { key: 'created', title: '创建播客', sub: '你创建的播客', itemType: 'radio' },
    liked: { key: 'liked', title: '喜欢的声音', sub: '收藏或最近喜欢的声音', itemType: 'voice' },
  }[key] || { key, title: key, sub: '', itemType: 'radio' };
  const first = (items || [])[0] || {};
  return {
    ...meta,
    count: (items || []).length,
    cover: first.cover || first.picUrl || first.coverUrl || '',
  };
}

async function fetchMyPodcastItems(key, info, limit, offset) {
  limit = Math.max(8, Math.min(60, Number(limit) || 30));
  offset = Math.max(0, Number(offset) || 0);
  if (key === 'collect') {
    const r = await dj_sublist({ limit, offset, cookie: userCookie, timestamp: Date.now() });
    const raw = firstArrayFrom(r.body, ['djRadios', 'djradios', 'radios', 'data']);
    return { itemType: 'radio', items: raw.map(x => mapPodcastCollectionRadio(x, key)).filter(x => x.id) };
  }
  if (key === 'created') {
    const r = await user_audio({ uid: info.userId, cookie: userCookie, timestamp: Date.now() });
    const raw = firstArrayFrom(r.body, ['data', 'djRadios', 'djradios', 'radios']);
    return { itemType: 'radio', items: raw.map(x => mapPodcastCollectionRadio(x, key)).filter(x => x.id) };
  }
  if (key === 'paid') {
    const r = await dj_paygift({ limit, offset, cookie: userCookie, timestamp: Date.now() });
    const raw = firstArrayFrom(r.body, ['data', 'djRadios', 'djradios', 'radios']);
    return { itemType: 'radio', items: raw.map(x => mapPodcastCollectionRadio(x, key)).filter(x => x.id) };
  }
  if (key === 'liked') {
    let raw = [];
    try {
      const sati = await sati_resource_sub_list({ cookie: userCookie, timestamp: Date.now() });
      raw = firstArrayFrom(sati.body, ['data', 'resources', 'list']);
    } catch (e) {
      console.warn('[MyPodcastLiked] sati sub list failed:', e.message);
    }
    if (!raw.length) {
      try {
        const recent = await record_recent_voice({ limit, cookie: userCookie, timestamp: Date.now() });
        raw = firstArrayFrom(recent.body, ['data', 'list', 'resources']);
      } catch (e) {
        console.warn('[MyPodcastLiked] recent voice fallback failed:', e.message);
      }
    }
    return { itemType: 'voice', items: raw.map(mapPodcastVoice).filter(x => x.id && x.name) };
  }
  return { itemType: 'radio', items: [] };
}

// ---------- 业务: 取歌曲URL (探测试听) ----------
//   返回 { url, trial, level, br }
//   trial=true 表示这是试听片段 (freeTrialInfo 非空)
async function handleSongUrl(id, loginInfo, qualityPreference) {
  console.log('[SongUrl] id:', id, 'logged-in:', !!userCookie);
  const requestedQuality = normalizeQualityPreference(qualityPreference);
  const svipReady = hasNeteaseSvip(loginInfo);
  const qualities = qualityCandidatesFrom(requestedQuality, NETEASE_QUALITY_CANDIDATES)
    .filter(q => !q.svip || svipReady);

  let trialFallback = null; // 兜底: 即使是试听也要能播
  let lastData = null;
  let lastError = null;

  for (const q of qualities) {
    try {
      // 优先用 v1 接口 (支持更高音质 level 字段)
      let result;
      try {
        result = await song_url_v1({ id, level: q.level, cookie: userCookie });
      } catch (e) {
        result = await song_url({ id, br: q.br, cookie: userCookie });
      }
      const d = result.body && result.body.data && result.body.data[0];
      if (d) lastData = d;
      const url = d && d.url;
      const freeTrial = d && d.freeTrialInfo;
      console.log('[SongUrl]', q.level, '->', url ? 'OK' : 'no url', freeTrial ? '(TRIAL)' : '');
      if (url && !freeTrial) {
        return { url, trial: false, playable: true, level: q.level, quality: q.label, br: d.br, requestedQuality };
      }
      if (url && freeTrial && !trialFallback) {
        trialFallback = {
          url,
          trial: true,
          playable: true,
          level: q.level,
          quality: q.label,
          br: d.br,
          requestedQuality,
          trialInfo: freeTrial,
          restriction: classifyNeteasePlaybackRestriction(d, loginInfo),
        };
      }
    } catch (err) {
      lastError = err;
      console.log('[SongUrl]', q.level, 'failed:', err.message);
    }
  }
  if (trialFallback) return trialFallback;
  const restriction = classifyNeteasePlaybackRestriction(lastData, loginInfo);
  return {
    url: null,
    trial: false,
    playable: false,
    reason: restriction.category,
    message: restriction.message,
    restriction,
    lastCode: lastData && lastData.code,
    fee: lastData && lastData.fee,
    error: lastError && lastError.message,
    requestedQuality,
  };
}

// ---------- 业务: 登录态/用户信息 ----------
function readCookieFromResponse(resp) {
  const candidates = [
    resp && resp.cookie,
    resp && resp.body && resp.body.cookie,
    resp && resp.body && resp.body.data && resp.body.data.cookie,
    resp && resp.body && resp.body.data && resp.body.data.cookies,
  ];
  for (const candidate of candidates) {
    const cookie = normalizeCookieHeader(candidate);
    if (cookie) return cookie;
  }
  return '';
}
function firstPositiveNumberFrom(objects, keys) {
  for (const obj of objects) {
    if (!obj || typeof obj !== 'object') continue;
    for (const key of keys) {
      const value = Number(obj[key]);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return 0;
}
function collectStringValues(value, out, depth) {
  if (depth > 4 || value == null) return out;
  if (typeof value === 'string') {
    if (value) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectStringValues(item, out, depth + 1));
    return out;
  }
  if (typeof value === 'object') {
    Object.keys(value).forEach(key => collectStringValues(value[key], out, depth + 1));
  }
  return out;
}
function collectVipStringValues(value, out, depth) {
  if (depth > 4 || value == null) return out;
  if (Array.isArray(value)) {
    value.forEach(item => collectVipStringValues(item, out, depth + 1));
    return out;
  }
  if (typeof value !== 'object') return out;
  Object.keys(value).forEach(key => {
    const child = value[key];
    if (/vip|svip|member|associator|privilege|right|level|package|label|title|type/i.test(key)) {
      collectStringValues(child, out, depth + 1);
    } else if (child && typeof child === 'object') {
      collectVipStringValues(child, out, depth + 1);
    }
  });
  return out;
}
function normalizeNeteaseVip(profile, account, extra) {
  profile = profile || {};
  account = account || {};
  extra = extra || {};
  const vipInfo = profile.vipInfo || profile.vipinfo || account.vipInfo || account.vipinfo || extra.vipInfo || extra.vipinfo || {};
  const objects = [account, profile, vipInfo, extra];
  const vipType = firstPositiveNumberFrom(objects, [
    'vipType', 'vip_type', 'viptype', 'musicVipType', 'music_vip_type',
    'musicVipLevel', 'music_vip_level', 'redVipLevel', 'red_vip_level',
    'blackVipLevel', 'black_vip_level', 'luxuryVipLevel', 'luxury_vip_level',
    'svipType', 'svip_type',
  ]);
  const text = collectVipStringValues({ account, profile, vipInfo, extra }, [], 0).join(' ').toLowerCase();
  const svipFlag = objects.some(obj => obj && (
    obj.isSvip === true || obj.is_svip === true || obj.svip === true ||
    Number(obj.isSvip || obj.is_svip || obj.svip || obj.svipType || obj.svip_type || 0) > 0
  )) || /svip|supervip|super_vip|blackvip|black_vip|黑胶svip|超级会员/.test(text);
  const vipFlag = objects.some(obj => obj && (
    obj.isVip === true || obj.is_vip === true || obj.vip === true ||
    Number(obj.isVip || obj.is_vip || obj.vip || obj.vipFlag || obj.vipflag || 0) > 0
  )) || /vip|黑胶|会员/.test(text);
  const isSvip = svipFlag || vipType >= 10;
  const isVip = isSvip || vipFlag || vipType > 0;
  const vipLevel = isSvip ? 'svip' : (isVip ? 'vip' : 'none');
  return {
    vipType,
    vipLevel,
    isVip,
    isSvip,
    vipLabel: vipLevel === 'svip' ? 'SVIP' : (vipLevel === 'vip' ? 'VIP' : '无VIP'),
  };
}
function normalizeLoginInfo(profile, account, extra) {
  profile = profile || {};
  account = account || {};
  const userId = profile.userId || profile.user_id || profile.id || account.userId || account.id || '';
  if (!(userId || userId === 0)) return { loggedIn: false };
  const vip = normalizeNeteaseVip(profile, account, extra);
  return {
    loggedIn: true,
    userId,
    nickname: profile.nickname || profile.userName || '网易云用户',
    avatar: profile.avatarUrl || profile.avatar || '',
    ...vip,
  };
}
function isNeteaseAuthInvalidPayload(payload) {
  const code = normalizeApiCode(payload);
  if (code === 301 || code === 401) return true;
  const msg = normalizeApiMessage(payload);
  return /未登录|需要登录|请先登录|login/i.test(msg) && code >= 300;
}
async function getLoginInfo() {
  if (!userCookie) return { loggedIn: false, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: '无VIP' };

  // login_status 对二维码 cookie 的资料刷新通常更及时；失败时再降级到 user_account。
  try {
    const st = await login_status({ cookie: userCookie, timestamp: Date.now() });
    const body = st.body || {};
    const data = body.data || body;
    const info = normalizeLoginInfo(data.profile || body.profile, data.account || body.account, data);
    if (info.loggedIn) return info;
  } catch (e) {
    console.warn('[Login] login_status failed:', e.message);
  }

  try {
    const acc = await user_account({ cookie: userCookie, timestamp: Date.now() });
    const body = acc.body || {};
    const info = normalizeLoginInfo(body.profile, body.account, body);
    if (info.loggedIn) return info;
    if (isNeteaseAuthInvalidPayload(acc)) saveCookie('');
    return { loggedIn: false, hasCookie: !!userCookie, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: '无VIP' };
  } catch (e) {
    console.warn('[Login] account check failed:', e.message);
    return { loggedIn: false, hasCookie: !!userCookie, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: '无VIP' };
  }
}

// ====================================================================
//  HTTP Server
// ====================================================================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const pn = url.pathname;

  if (pn === '/api/app/version') {
    sendJSON(res, {
      name: APP_PACKAGE.name || 'xk-radio',
      productName: APP_PACKAGE.productName || 'XK Radio',
      version: APP_VERSION,
      update: {
        provider: UPDATE_CONFIG.provider,
        configured: UPDATE_CONFIG.configured,
        owner: UPDATE_CONFIG.owner,
        repo: UPDATE_CONFIG.repo,
        preview: UPDATE_CONFIG.preview,
        manifestOverride: !!UPDATE_CONFIG.manifest,
      },
    });
    return;
  }

  if (pn === '/api/update/latest') {
    try {
      sendJSON(res, await fetchLatestUpdateInfo());
    } catch (err) {
      sendJSON(res, {
        ...localUpdateFallback(err.message || 'Update check failed', { configured: UPDATE_CONFIG.configured }),
        error: err.message || 'Update check failed',
      });
    }
    return;
  }

  if (pn === '/api/update/download') {
    try {
      const info = await fetchLatestUpdateInfo();
      const job = startUpdateDownloadJob(info);
      sendJSON(res, job, job.ok ? 200 : 400);
    } catch (err) {
      console.error('[UpdateDownload]', err);
      sendJSON(res, { ok: false, error: err.message || 'UPDATE_DOWNLOAD_START_FAILED' }, 500);
    }
    return;
  }

  if (pn === '/api/update/download/status') {
    const id = url.searchParams.get('id') || '';
    const job = id
      ? updateDownloadJobs.get(id)
      : Array.from(updateDownloadJobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
    sendJSON(res, publicUpdateJob(job), job ? 200 : 404);
    return;
  }

  if (pn === '/api/update/download/pause') {
    const id = url.searchParams.get('id') || '';
    const job = pauseUpdateDownloadJob(id);
    sendJSON(res, job, job.ok ? 200 : 400);
    return;
  }

  if (pn === '/api/update/download/resume') {
    const id = url.searchParams.get('id') || '';
    const job = resumeUpdateDownloadJob(id);
    sendJSON(res, job, job.ok ? 200 : 400);
    return;
  }

  if (pn === '/api/update/patch') {
    try {
      const info = await fetchLatestUpdateInfo();
      const job = startUpdatePatchJob(info);
      sendJSON(res, job, job.ok ? 200 : 400);
    } catch (err) {
      console.error('[UpdatePatch]', err);
      sendJSON(res, { ok: false, error: err.message || 'UPDATE_PATCH_START_FAILED' }, 500);
    }
    return;
  }

  if (pn === '/api/update/patch/status') {
    const id = url.searchParams.get('id') || '';
    const job = id
      ? updateDownloadJobs.get(id)
      : Array.from(updateDownloadJobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).find(item => item.mode === 'patch');
    sendJSON(res, publicUpdateJob(job), job ? 200 : 404);
    return;
  }

  if (pn === '/api/beatmap/cache/status') {
    const info = beatCacheRootInfo();
    sendJSON(res, {
      enabled: info.allowed && info.available,
      dir: info.dir,
      drive: info.drive,
      reason: !info.allowed ? 'C_DRIVE_DISABLED' : (!info.available ? 'TARGET_DRIVE_UNAVAILABLE' : ''),
      mode: info.allowed && info.available ? 'disk' : 'memory-only',
    });
    return;
  }

  if (pn === '/api/beatmap/cache') {
    if (req.method === 'GET') {
      const key = url.searchParams.get('key') || '';
      try {
        const entry = readBeatMapCache(key);
        sendJSON(res, entry
          ? { ok: true, hit: true, key: entry.key || key, map: entry.map, meta: entry.meta || {}, savedAt: entry.savedAt || 0 }
          : { ok: true, hit: false, key });
      } catch (err) {
        const info = err.info || beatCacheRootInfo();
        sendJSON(res, {
          ok: false,
          hit: false,
          enabled: false,
          mode: 'memory-only',
          key,
          reason: err.code || err.message || 'BEAT_CACHE_READ_FAILED',
          dir: info.dir,
        });
      }
      return;
    }

    if (req.method === 'POST') {
      try {
        const body = await readRequestBody(req);
        sendJSON(res, writeBeatMapCache(body));
      } catch (err) {
        const info = err.info || beatCacheRootInfo();
        sendJSON(res, {
          ok: false,
          enabled: false,
          mode: 'memory-only',
          reason: err.code || err.message || 'BEAT_CACHE_WRITE_FAILED',
          dir: info.dir,
        });
      }
      return;
    }

    sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
    return;
  }

  if (pn === '/api/discover/home') {
    try {
      sendJSON(res, await handleDiscoverHome());
    } catch (err) {
      console.error('[DiscoverHome]', err);
      sendJSON(res, { error: err.message, loggedIn: false, dailySongs: [], playlists: [], podcasts: [] }, 500);
    }
    return;
  }

  if (pn === '/api/weather/radio') {
    try {
      const data = await buildWeatherRadio({
        city: url.searchParams.get('city') || url.searchParams.get('q') || '',
        lat: url.searchParams.get('lat'),
        lon: url.searchParams.get('lon'),
        timezone: url.searchParams.get('timezone') || '',
      });
      sendJSON(res, data);
    } catch (err) {
      console.error('[WeatherRadio]', err);
      sendJSON(res, {
        ok: false,
        error: err.message,
        weather: null,
        radio: { title: '天气电台', subtitle: '天气暂时没有回来，可以先听今日推荐。', seedQueries: [], songs: [] },
      }, 500);
    }
    return;
  }

  if (pn === '/api/weather/ip-location') {
    try {
      sendJSON(res, { ok: true, location: await fetchIpWeatherLocation() });
    } catch (err) {
      console.error('[WeatherIpLocation]', err);
      sendJSON(res, { ok: false, error: err.message, location: null }, 500);
    }
    return;
  }

  // ---------- 搜索 ----------
  if (pn === '/api/search') {
    try {
      const kw    = url.searchParams.get('keywords') || '';
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const songs = await handleSearch(kw, limit);
      sendJSON(res, { songs });
    } catch (err) { console.error('[Search]', err); sendJSON(res, { error: err.message, songs: [] }, 500); }
    return;
  }

  if (pn === '/api/qq/search') {
    try {
      const kw = url.searchParams.get('keywords') || '';
      const limit = Math.max(4, Math.min(12, parseInt(url.searchParams.get('limit') || '8', 10) || 8));
      const songs = await handleQQSearch(kw, limit);
      sendJSON(res, { provider: 'qq', songs });
    } catch (err) {
      console.error('[QQSearch]', err);
      sendJSON(res, { provider: 'qq', error: err.message, songs: [] }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/search') {
    try {
      const kw = url.searchParams.get('keywords') || '';
      const limit = Math.max(4, Math.min(18, parseInt(url.searchParams.get('limit') || '10', 10) || 10));
      const songs = await handleKugouSearch(kw, limit);
      sendJSON(res, { provider: 'kugou', songs });
    } catch (err) {
      console.error('[KugouSearch]', err);
      sendJSON(res, { provider: 'kugou', error: err.message, songs: [] }, 500);
    }
    return;
  }

  if (pn === '/api/soda/search') {
    try {
      const kw = url.searchParams.get('keywords') || '';
      const limit = Math.max(4, Math.min(18, parseInt(url.searchParams.get('limit') || '10', 10) || 10));
      const songs = await handleSodaSearch(kw, limit);
      sendJSON(res, { provider: 'soda', songs });
    } catch (err) {
      console.error('[SodaSearch]', err);
      sendJSON(res, { provider: 'soda', error: err.message, songs: [] }, 500);
    }
    return;
  }

  if (pn === '/api/qq/song/url') {
    try {
      const mid = url.searchParams.get('mid') || url.searchParams.get('id') || '';
      const mediaMid = url.searchParams.get('mediaMid') || url.searchParams.get('media_mid') || '';
      const quality = url.searchParams.get('quality') || '';
      const info = await handleQQSongUrl(mid, mediaMid, quality);
      sendJSON(res, info);
    } catch (err) {
      console.error('[QQSongUrl]', err);
      sendJSON(res, { provider: 'qq', url: '', playable: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/song/url') {
    try {
      const hash = url.searchParams.get('hash') || url.searchParams.get('id') || '';
      const albumId = url.searchParams.get('albumId') || url.searchParams.get('album_id') || '';
      const albumAudioId = url.searchParams.get('albumAudioId') || url.searchParams.get('album_audio_id') || url.searchParams.get('audioId') || '';
      const encodeAlbumAudioId = url.searchParams.get('encodeAlbumAudioId') || url.searchParams.get('encode_album_audio_id') || url.searchParams.get('encodeAudioId') || '';
      const quality = url.searchParams.get('quality') || '';
      const info = await handleKugouSongUrl(hash, albumId, quality, albumAudioId, encodeAlbumAudioId);
      sendJSON(res, info);
    } catch (err) {
      console.error('[KugouSongUrl]', err);
      sendJSON(res, { provider: 'kugou', url: '', playable: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/soda/song/url') {
    try {
      const id = url.searchParams.get('id') || url.searchParams.get('trackId') || url.searchParams.get('track_id') || '';
      const quality = url.searchParams.get('quality') || '';
      const info = await handleSodaSongUrl(id, quality);
      sendJSON(res, info);
    } catch (err) {
      console.error('[SodaSongUrl]', err);
      sendJSON(res, { provider: 'soda', url: '', playable: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/qq/lyric') {
    try {
      const mid = url.searchParams.get('mid') || url.searchParams.get('songmid') || '';
      const id = url.searchParams.get('id') || url.searchParams.get('qqId') || '';
      if (!mid && !id) { sendJSON(res, { provider: 'qq', error: 'Missing QQ song mid or id', lyric: '' }, 400); return; }
      const data = await handleQQLyric(mid, id);
      sendJSON(res, data);
    } catch (err) {
      console.error('[QQLyric]', err);
      sendJSON(res, { provider: 'qq', error: err.message, lyric: '' }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/lyric') {
    try {
      const hash = url.searchParams.get('hash') || url.searchParams.get('id') || '';
      const keyword = url.searchParams.get('keyword') || '';
      const duration = url.searchParams.get('duration') || '0';
      const data = await handleKugouLyric(hash, keyword, duration);
      sendJSON(res, data);
    } catch (err) {
      console.error('[KugouLyric]', err);
      sendJSON(res, { provider: 'kugou', error: err.message, lyric: '' }, 500);
    }
    return;
  }

  if (pn === '/api/soda/lyric') {
    try {
      const id = url.searchParams.get('id') || url.searchParams.get('trackId') || url.searchParams.get('track_id') || '';
      const data = await handleSodaLyric(id);
      sendJSON(res, data);
    } catch (err) {
      console.error('[SodaLyric]', err);
      sendJSON(res, { provider: 'soda', error: err.message, lyric: '' }, 500);
    }
    return;
  }

  // ---------- 歌曲URL ----------
  if (pn === '/api/qq/login/status') {
    try {
      const info = await getQQLoginInfo();
      sendJSON(res, info);
    } catch (err) {
      console.error('[QQLoginStatus]', err);
      sendJSON(res, { provider: 'qq', loggedIn: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/qq/login/cookie') {
    try {
      const body = await readRequestBody(req);
      const raw = body.cookie || body.data || body.text || '';
      const normalized = normalizeQQCookieInput(raw);
      const obj = parseCookieString(normalized);
      if (!qqCookieUin(obj) || !qqCookieMusicKey(obj)) {
        sendJSON(res, { provider: 'qq', loggedIn: false, error: 'INVALID_QQ_COOKIE', message: 'QQ cookie 缺少 uin 或有效登录票据' }, 400);
        return;
      }
      saveQQCookie(normalized);
      const info = await getQQLoginInfo();
      sendJSON(res, { ...info, saved: true });
    } catch (err) {
      console.error('[QQLoginCookie]', err);
      sendJSON(res, { provider: 'qq', loggedIn: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/qq/logout') {
    saveQQCookie('');
    sendJSON(res, { provider: 'qq', ok: true, loggedIn: false });
    return;
  }

  if (pn === '/api/kugou/login/status') {
    try {
      const info = await getKugouLoginInfo();
      sendJSON(res, info);
    } catch (err) {
      console.error('[KugouLoginStatus]', err);
      sendJSON(res, { provider: 'kugou', loggedIn: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/login/cookie') {
    try {
      const body = await readRequestBody(req);
      const raw = body.cookie || body.data || body.text || '';
      const normalized = normalizeKugouCookieInput(raw);
      const obj = expandKugouCookieObject(parseCookieString(normalized));
      if (!kugouCookieUserId(obj) || !kugouCookieToken(obj)) {
        sendJSON(res, { provider: 'kugou', loggedIn: false, error: 'INVALID_KUGOU_COOKIE', message: '酷狗 cookie 缺少用户 ID 或有效登录票据' }, 400);
        return;
      }
      const refreshed = await refreshKugouMobileLoginCookie(normalized);
      saveKugouCookie(refreshed || normalized);
      const info = await getKugouLoginInfo();
      sendJSON(res, { ...info, saved: true });
    } catch (err) {
      console.error('[KugouLoginCookie]', err);
      sendJSON(res, { provider: 'kugou', loggedIn: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/logout') {
    saveKugouCookie('');
    sendJSON(res, { provider: 'kugou', ok: true, loggedIn: false });
    return;
  }

  if (pn === '/api/soda/login/status') {
    try {
      const info = await getSodaLoginInfo();
      sendJSON(res, info);
    } catch (err) {
      console.error('[SodaLoginStatus]', err);
      sendJSON(res, { provider: 'soda', loggedIn: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/soda/login/cookie') {
    try {
      const body = await readRequestBody(req);
      const raw = body.cookie || body.data || body.text || '';
      const normalized = normalizeSodaCookieInput(raw);
      if (!sodaCookieHasLogin(normalized)) {
        sendJSON(res, { provider: 'soda', loggedIn: false, error: 'INVALID_SODA_COOKIE', message: '汽水 cookie 缺少有效登录票据' }, 400);
        return;
      }
      saveSodaCookie(normalized);
      const info = await getSodaLoginInfo();
      sendJSON(res, { ...info, saved: true });
    } catch (err) {
      console.error('[SodaLoginCookie]', err);
      sendJSON(res, { provider: 'soda', loggedIn: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/soda/logout') {
    saveSodaCookie('');
    sendJSON(res, { provider: 'soda', ok: true, loggedIn: false });
    return;
  }

  if (pn === '/api/qq/user/playlists') {
    try {
      const data = await handleQQUserPlaylists();
      sendJSON(res, data);
    } catch (err) {
      console.error('[QQUserPlaylists]', err);
      sendJSON(res, { provider: 'qq', loggedIn: false, error: err.message, playlists: [] }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/user/playlists') {
    try {
      const page = url.searchParams.get('page') || '1';
      const pagesize = url.searchParams.get('pagesize') || '100';
      const data = await handleKugouUserPlaylists(page, pagesize);
      sendJSON(res, data);
    } catch (err) {
      console.error('[KugouUserPlaylists]', err);
      sendJSON(res, { provider: 'kugou', loggedIn: true, playlistReady: false, error: err.message, playlists: [] });
    }
    return;
  }

  if (pn === '/api/soda/user/playlists') {
    try {
      const data = await handleSodaUserPlaylists();
      sendJSON(res, data);
    } catch (err) {
      console.error('[SodaUserPlaylists]', err);
      sendJSON(res, { provider: 'soda', loggedIn: true, error: err.message, playlists: [] }, 500);
    }
    return;
  }

  if (pn === '/api/qq/playlist/tracks') {
    try {
      const id = url.searchParams.get('id') || url.searchParams.get('disstid') || '';
      const data = await handleQQPlaylistTracks(id);
      sendJSON(res, data);
    } catch (err) {
      console.error('[QQPlaylistTracks]', err);
      sendJSON(res, { provider: 'qq', error: err.message, tracks: [] }, 500);
    }
    return;
  }

  if (pn === '/api/soda/playlist/tracks') {
    try {
      const id = url.searchParams.get('id') || url.searchParams.get('kind') || '';
      const limit = url.searchParams.get('limit') || '50';
      const data = await handleSodaPlaylistTracks(id, limit);
      sendJSON(res, data);
    } catch (err) {
      console.error('[SodaPlaylistTracks]', err);
      sendJSON(res, { provider: 'soda', error: err.message, tracks: [] }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/playlist/tracks') {
    try {
      const id = url.searchParams.get('id') || url.searchParams.get('specialid') || '';
      const listid = url.searchParams.get('listid') || '';
      const personal = /^(1|true|yes)$/i.test(url.searchParams.get('personal') || '');
      const limit = url.searchParams.get('limit') || '50';
      const personalId = /^collection_/i.test(String(id || '')) ? id : (listid || id);
      const data = (listid || personal)
        ? await handleKugouPersonalPlaylistTracks(personalId, limit)
        : await handleKugouPlaylistTracks(id, limit);
      sendJSON(res, data);
    } catch (err) {
      console.error('[KugouPlaylistTracks]', err);
      sendJSON(res, {
        provider: 'kugou',
        error: err.message,
        tracks: [],
        transient: true,
        attempts: err.body && err.body.attempts || [],
      }, 500);
    }
    return;
  }

  if (pn === '/api/qq/artist/detail') {
    try {
      const mid = url.searchParams.get('mid') || url.searchParams.get('singermid') || '';
      const limit = Math.max(10, Math.min(80, parseInt(url.searchParams.get('limit') || '36', 10) || 36));
      if (!mid) {
        sendJSON(res, { provider: 'qq', error: 'MISSING_SINGER_MID', artist: null, songs: [] }, 400);
        return;
      }
      const data = await handleQQArtistDetail(mid, limit);
      sendJSON(res, data);
    } catch (err) {
      console.error('[QQArtistDetail]', err);
      sendJSON(res, { provider: 'qq', error: err.message, artist: null, songs: [] }, 500);
    }
    return;
  }

  if (pn === '/api/qq/song/comments') {
    try {
      const id = url.searchParams.get('id') || url.searchParams.get('qqId') || '';
      const mid = url.searchParams.get('mid') || url.searchParams.get('songmid') || '';
      const limit = Math.max(6, Math.min(50, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const data = await handleQQSongComments(id, mid, limit, offset);
      sendJSON(res, data);
    } catch (err) {
      console.error('[QQSongComments]', err);
      sendJSON(res, { provider: 'qq', error: err.message, comments: [] }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/search') {
    try {
      const kw = String(url.searchParams.get('keywords') || '').trim();
      const limit = Math.max(6, Math.min(30, parseInt(url.searchParams.get('limit') || '18', 10) || 18));
      if (!kw) { sendJSON(res, { podcasts: [] }); return; }
      const r = await cloudsearch({ keywords: kw, type: 1009, limit, cookie: userCookie, timestamp: Date.now() });
      const result = (r.body && r.body.result) || {};
      const raw = result.djRadios || result.djradios || result.radios || [];
      const podcasts = raw.map(mapPodcastRadio).filter(p => p.id);
      sendJSON(res, { podcasts, total: result.djRadiosCount || result.djradiosCount || podcasts.length });
    } catch (err) {
      console.error('[PodcastSearch]', err);
      sendJSON(res, { error: err.message, podcasts: [] }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/hot') {
    try {
      const limit = Math.max(6, Math.min(30, parseInt(url.searchParams.get('limit') || '18', 10) || 18));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const r = await dj_hot({ limit, offset, cookie: userCookie, timestamp: Date.now() });
      const body = r.body || {};
      const raw = body.djRadios || body.djradios || body.radios || body.data || [];
      const podcasts = (Array.isArray(raw) ? raw : []).map(mapPodcastRadio).filter(p => p.id);
      sendJSON(res, { podcasts, more: !!body.hasMore });
    } catch (err) {
      console.error('[PodcastHot]', err);
      sendJSON(res, { error: err.message, podcasts: [] }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/detail') {
    try {
      const rid = url.searchParams.get('id') || url.searchParams.get('rid');
      if (!rid) { sendJSON(res, { error: 'Missing podcast id' }, 400); return; }
      const r = await dj_detail({ rid, cookie: userCookie, timestamp: Date.now() });
      const body = r.body || {};
      const radio = mapPodcastRadio(body.data || body.djRadio || body.radio || body);
      sendJSON(res, { podcast: radio });
    } catch (err) {
      console.error('[PodcastDetail]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/programs') {
    try {
      const rid = url.searchParams.get('id') || url.searchParams.get('rid');
      if (!rid) { sendJSON(res, { error: 'Missing podcast id', programs: [] }, 400); return; }
      const limit = Math.max(10, Math.min(60, parseInt(url.searchParams.get('limit') || '30', 10) || 30));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const r = await dj_program({ rid, limit, offset, asc: false, cookie: userCookie, timestamp: Date.now() });
      const body = r.body || {};
      const raw = body.programs || (body.data && (body.data.list || body.data.programs)) || [];
      const radio = raw[0] && raw[0].radio ? mapPodcastRadio(raw[0].radio) : { id: rid, rid };
      const programs = (Array.isArray(raw) ? raw : [])
        .map(p => mapPodcastProgram(p, radio))
        .filter(p => p.id && p.name);
      sendJSON(res, { radio, programs, more: !!body.more, total: body.count || programs.length });
    } catch (err) {
      console.error('[PodcastPrograms]', err);
      sendJSON(res, { error: err.message, programs: [] }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/my') {
    try {
      const info = await getLoginInfo();
      if (!info.loggedIn || !info.userId) {
        const empty = ['collect', 'created', 'liked'].map(k => podcastCollectionMeta(k, []));
        sendJSON(res, { loggedIn: false, collections: empty });
        return;
      }
      const keys = ['collect', 'created', 'liked'];
      const collections = await Promise.all(keys.map(async key => {
        try {
          const data = await fetchMyPodcastItems(key, info, 12, 0);
          return podcastCollectionMeta(key, data.items || []);
        } catch (e) {
          console.warn('[MyPodcast]', key, e.message);
          return podcastCollectionMeta(key, []);
        }
      }));
      sendJSON(res, { loggedIn: true, collections });
    } catch (err) {
      console.error('[MyPodcast]', err);
      sendJSON(res, { error: err.message, collections: [] }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/my/items') {
    try {
      const info = await getLoginInfo();
      if (!info.loggedIn || !info.userId) { sendJSON(res, { loggedIn: false, items: [] }); return; }
      const key = String(url.searchParams.get('key') || 'collect');
      const limit = parseInt(url.searchParams.get('limit') || '36', 10) || 36;
      const offset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;
      const data = await fetchMyPodcastItems(key, info, limit, offset);
      sendJSON(res, { loggedIn: true, key, ...podcastCollectionMeta(key, data.items || []), itemType: data.itemType, items: data.items || [] });
    } catch (err) {
      console.error('[MyPodcastItems]', err);
      sendJSON(res, { error: err.message, items: [] }, 500);
    }
    return;
  }

  if (pn === '/api/song/url') {
    try {
      const sid = url.searchParams.get('id');
      const quality = url.searchParams.get('quality') || '';
      const loginInfo = await getLoginInfo();
      const info = await handleSongUrl(sid, loginInfo, quality);
      sendJSON(res, {
        ...info,
        loggedIn: loginInfo.loggedIn,
        vipType: loginInfo.vipType || 0,
        vipLevel: loginInfo.vipLevel || 'none',
        isVip: !!loginInfo.isVip,
        isSvip: !!loginInfo.isSvip,
        vipLabel: loginInfo.vipLabel || '无VIP',
      });
    } catch (err) { console.error('[SongUrl]', err); sendJSON(res, { error: err.message }, 500); }
    return;
  }

  if (pn === '/api/login/cookie') {
    try {
      const body = await readRequestBody(req);
      const raw = body.cookie || body.data || body.text || '';
      const normalized = normalizeCookieHeader(raw);
      const obj = parseCookieString(normalized);
      if (!obj.MUSIC_U) {
        sendJSON(res, { loggedIn: false, error: 'INVALID_NETEASE_COOKIE', message: '网易云 cookie 缺少 MUSIC_U' }, 400);
        return;
      }
      saveCookie(normalized);
      let info = await getLoginInfo();
      if (!info.loggedIn && userCookie) {
        info = {
          loggedIn: true,
          pendingProfile: true,
          nickname: '网易云用户',
          avatar: '',
          vipType: 0,
          vipLevel: 'none',
          isVip: false,
          isSvip: false,
          vipLabel: '无VIP',
        };
      }
      sendJSON(res, { ...info, saved: true, hasCookie: !!userCookie });
    } catch (err) {
      console.error('[LoginCookie]', err);
      sendJSON(res, { loggedIn: false, error: err.message }, 500);
    }
    return;
  }

  // ---------- 登录: QR Key ----------
  // ---------- 播客 DJ 长音频后端离线锁拍 ----------
  if (pn === '/api/podcast/dj-beatmap') {
    try {
      const audioUrl = url.searchParams.get('url');
      const durationSec = Math.max(0, Number(url.searchParams.get('duration') || 0) || 0);
      if (!audioUrl || !/^https?:\/\//i.test(audioUrl)) {
        sendJSON(res, { error: 'Invalid audio url' }, 400);
        return;
      }
      console.log('[PodcastDjBeatmap] start', Math.round(durationSec || 0) + 's');
      const started = Date.now();
      const introSec = Math.max(0, Number(url.searchParams.get('intro') || 0) || 0);
      const map = introSec
        ? await analyzePodcastDjIntro(audioUrl, { durationSec, introSec, userAgent: UA })
        : await analyzePodcastDjStream(audioUrl, { durationSec, userAgent: UA });
      console.log('[PodcastDjBeatmap] done beats:', map.visualBeatCount || 0, 'ms:', Date.now() - started, 'decode:', map.decode || {});
      sendJSON(res, { ok: true, map });
    } catch (err) {
      console.error('[PodcastDjBeatmap]', err);
      sendJSON(res, { ok: false, error: err.message || String(err) }, 500);
    }
    return;
  }

  if (pn === '/api/login/qr/key') {
    try {
      const r = await login_qr_key({ timestamp: Date.now() });
      const key = r.body && r.body.data && r.body.data.unikey;
      sendJSON(res, { key });
    } catch (err) { sendJSON(res, { error: err.message }, 500); }
    return;
  }

  // ---------- 登录: QR 二维码图片 ----------
  if (pn === '/api/login/qr/create') {
    try {
      const key = url.searchParams.get('key');
      const r = await login_qr_create({ key, qrimg: true, timestamp: Date.now() });
      const d = r.body && r.body.data;
      sendJSON(res, { img: d && d.qrimg, url: d && d.qrurl });
    } catch (err) { sendJSON(res, { error: err.message }, 500); }
    return;
  }

  // ---------- 登录: 轮询扫码状态 ----------
  if (pn === '/api/login/qr/check') {
    try {
      const key = url.searchParams.get('key');
      let r = await login_qr_check({ key, noCookie: true, timestamp: Date.now() });
      let body = r.body || {};
      let code = Number(body.code || r.code);
      let msg  = body.message || r.message || '';
      let cookie = readCookieFromResponse(r);
      if (code === 803 && !cookie) {
        try {
          const retry = await login_qr_check({ key, timestamp: Date.now() });
          const retryCookie = readCookieFromResponse(retry);
          if (retryCookie) {
            r = retry;
            body = retry.body || body;
            code = Number(body.code || retry.code || code);
            msg = body.message || retry.message || msg;
            cookie = retryCookie;
          }
        } catch (retryErr) {
          console.warn('[Login] qr cookie retry failed:', retryErr.message);
        }
      }
      // 803 = 授权成功, 802 = 已扫待确认, 801 = 等待扫码, 800 = 二维码过期
      if (code === 803) {
        if (cookie) saveCookie(cookie);
        let info = await getLoginInfo();
        if (!info.loggedIn) {
          const profile = body.profile || (body.data && body.data.profile) || {};
          info = normalizeLoginInfo(profile, body.account || (body.data && body.data.account), body.data || body);
        }
        if (!info.loggedIn && cookie) {
          info = {
            loggedIn: true,
            pendingProfile: true,
            nickname: (body.nickname || (body.profile && body.profile.nickname) || '网易云用户'),
            avatar: body.avatarUrl || (body.profile && body.profile.avatarUrl) || '',
            vipType: 0,
            vipLevel: 'none',
            isVip: false,
            isSvip: false,
            vipLabel: '无VIP',
          };
        }
        sendJSON(res, { code, message: msg, ...info, hasCookie: !!cookie });
        return;
      }
      sendJSON(res, { code, message: msg, nickname: body.nickname, avatar: body.avatarUrl });
    } catch (err) { sendJSON(res, { error: err.message }, 500); }
    return;
  }

  // ---------- 登录态查询 ----------
  if (pn === '/api/login/status') {
    const info = await getLoginInfo();
    sendJSON(res, info);
    return;
  }

  // ---------- 登出 ----------
  if (pn === '/api/logout') {
    try { await logout({ cookie: userCookie }); } catch (e) {}
    saveCookie('');
    sendJSON(res, { ok: true });
    return;
  }

  // ---------- 用户歌单 ----------
  if (pn === '/api/user/playlists') {
    try {
      const info = await getLoginInfo();
      if (!info.loggedIn || !info.userId) { sendJSON(res, { loggedIn: false, playlists: [] }); return; }
      const limit = Math.max(12, Math.min(100, parseInt(url.searchParams.get('limit') || '60', 10) || 60));
      const r = await user_playlist({ uid: info.userId, limit, cookie: userCookie, timestamp: Date.now() });
      const list = ((r.body && r.body.playlist) || []).map(pl => ({
        id: pl.id,
        name: pl.name,
        cover: pl.coverImgUrl || '',
        trackCount: pl.trackCount || 0,
        playCount: pl.playCount || 0,
        creator: (pl.creator && pl.creator.nickname) || '',
        subscribed: !!pl.subscribed,
        specialType: pl.specialType || 0,
      }));
      sendJSON(res, { loggedIn: true, userId: info.userId, playlists: list });
    } catch (err) {
      console.error('[UserPlaylists]', err);
      sendJSON(res, { error: err.message, loggedIn: false, playlists: [] }, 500);
    }
    return;
  }

  // ---------- 红心状态 ----------
  if (pn === '/api/song/like/check') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const ids = String(url.searchParams.get('ids') || url.searchParams.get('id') || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      if (!ids.length) { sendJSON(res, { error: 'Missing song id', liked: {}, ids: [] }, 400); return; }
      let likedIds = [];
      try {
        if (typeof song_like_check === 'function') {
          const checked = await song_like_check({ ids: JSON.stringify(ids.map(Number).filter(Boolean)), cookie: userCookie, timestamp: Date.now() });
          const data = (checked.body && (checked.body.data || checked.body.ids)) || checked.body || {};
          if (Array.isArray(data)) likedIds = data.map(String);
          else if (data && typeof data === 'object') {
            ids.forEach(id => {
              if (data[id] || data[String(id)] || data[Number(id)]) likedIds.push(String(id));
            });
          }
        }
      } catch (e) {
        console.warn('[LikeCheck] direct check failed:', e.message);
      }
      if (!likedIds.length) {
        const r = await likelist({ uid: info.userId, cookie: userCookie, timestamp: Date.now() });
        likedIds = ((r.body && r.body.ids) || []).map(String);
      }
      const set = new Set(likedIds);
      const liked = {};
      ids.forEach(id => { liked[id] = set.has(String(id)); });
      sendJSON(res, { loggedIn: true, ids, liked });
    } catch (err) {
      console.error('[LikeCheck]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  // ---------- 红心/取消红心 ----------
  if (pn === '/api/song/like') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const body = req.method === 'POST' ? await readRequestBody(req) : {};
      const id = body.id || url.searchParams.get('id');
      const nextLike = String(body.like != null ? body.like : (url.searchParams.get('like') || 'true')) !== 'false';
      if (!id) { sendJSON(res, { error: 'Missing song id' }, 400); return; }
      const r = await like_song({ id, like: String(nextLike), cookie: userCookie, timestamp: Date.now() });
      const code = (r.body && r.body.code) || r.code || 200;
      sendJSON(res, { loggedIn: true, id, liked: nextLike, code, body: r.body || r });
    } catch (err) {
      console.error('[Like]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  // ---------- 创建歌单 ----------
  if (pn === '/api/playlist/create') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const body = req.method === 'POST' ? await readRequestBody(req) : {};
      const name = String(body.name || url.searchParams.get('name') || '').trim();
      const privacy = String(body.privacy || url.searchParams.get('privacy') || '0');
      if (!name) { sendJSON(res, { error: 'Missing playlist name' }, 400); return; }
      const r = await playlist_create({ name, privacy, cookie: userCookie, timestamp: Date.now() });
      const created = (r.body && (r.body.playlist || r.body.data)) || {};
      sendJSON(res, { loggedIn: true, playlist: created, body: r.body || r });
    } catch (err) {
      console.error('[PlaylistCreate]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  // ---------- 收藏歌曲到歌单 ----------
  if (pn === '/api/playlist/add-song') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const body = req.method === 'POST' ? await readRequestBody(req) : {};
      const pid = body.pid || url.searchParams.get('pid');
      const id = body.id || body.ids || url.searchParams.get('id') || url.searchParams.get('ids');
      if (!pid || !id) { sendJSON(res, { error: 'Missing playlist id or song id' }, 400); return; }
      const attempts = [];
      let finalBody = null;
      let finalCode = 0;
      let finalMessage = '';
      let success = false;

      const primary = await playlist_tracks({ op: 'add', pid, tracks: String(id), cookie: userCookie, timestamp: Date.now() });
      finalBody = primary.body || primary;
      finalCode = normalizeApiCode(primary);
      finalMessage = normalizeApiMessage(primary);
      success = finalCode === 200 && !(finalBody && finalBody.error);
      attempts.push({ api: 'playlist_tracks', code: finalCode, message: finalMessage, body: finalBody });

      if (!success && typeof playlist_track_add === 'function') {
        try {
          const fallback = await playlist_track_add({ pid, ids: String(id), cookie: userCookie, timestamp: Date.now() });
          finalBody = fallback.body || fallback;
          finalCode = normalizeApiCode(fallback);
          finalMessage = normalizeApiMessage(fallback);
          success = finalCode === 200 && !(finalBody && finalBody.error);
          attempts.push({ api: 'playlist_track_add', code: finalCode, message: finalMessage, body: finalBody });
        } catch (fallbackErr) {
          const errBody = fallbackErr.body || fallbackErr.response || {};
          finalBody = errBody;
          finalCode = normalizeApiCode(errBody);
          finalMessage = normalizeApiMessage(errBody) || fallbackErr.message || '';
          attempts.push({ api: 'playlist_track_add', code: finalCode, message: finalMessage, body: errBody });
        }
      }

      if (!success) {
        sendJSON(res, { loggedIn: true, pid, id, success: false, code: finalCode, error: finalMessage || 'PLAYLIST_ADD_FAILED', attempts }, finalCode === 401 ? 401 : 409);
        return;
      }
      sendJSON(res, { loggedIn: true, pid, id, success: true, code: finalCode, body: finalBody, attempts });
    } catch (err) {
      console.error('[PlaylistAddSong]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  // ---------- 歌词 ----------
  if (pn === '/api/lyric') {
    try {
      const id = url.searchParams.get('id');
      if (!id) { sendJSON(res, { error: 'Missing song id', lyric: '' }, 400); return; }
      let body = {};
      let source = 'lyric';
      try {
        if (typeof lyric_new === 'function') {
          const nr = await lyric_new({ id, cookie: userCookie, timestamp: Date.now() });
          body = nr.body || {};
          source = 'lyric_new';
        }
      } catch (errNew) {
        console.warn('[LyricNew]', errNew.message);
      }
      if (!((body.lrc && body.lrc.lyric) || (body.yrc && body.yrc.lyric))) {
        const r = await lyric({ id, cookie: userCookie, timestamp: Date.now() });
        body = r.body || body || {};
        source = 'lyric';
      }
      sendJSON(res, {
        lyric: (body.lrc && body.lrc.lyric) || '',
        tlyric: (body.tlyric && body.tlyric.lyric) || '',
        yrc: (body.yrc && body.yrc.lyric) || '',
        source,
      });
    } catch (err) {
      console.error('[Lyric]', err);
      sendJSON(res, { error: err.message, lyric: '' }, 500);
    }
    return;
  }

  // ---------- 歌曲评论 ----------
  if (pn === '/api/song/comments') {
    try {
      const id = url.searchParams.get('id');
      const limit = Math.max(6, Math.min(50, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      if (!id) { sendJSON(res, { error: 'Missing song id', comments: [] }, 400); return; }
      const r = await comment_music({ id, limit, offset, cookie: userCookie, timestamp: Date.now() });
      const body = r.body || r || {};
      const raw = body.hotComments && offset === 0 ? body.hotComments : (body.comments || []);
      const comments = (raw || []).map(c => ({
        id: c.commentId,
        content: c.content || '',
        likedCount: c.likedCount || 0,
        time: c.time || 0,
        user: c.user ? { id: c.user.userId, nickname: c.user.nickname || '', avatar: c.user.avatarUrl || '' } : null,
      })).filter(c => c.content);
      sendJSON(res, { id, total: body.total || 0, comments, hot: !!(body.hotComments && offset === 0), body });
    } catch (err) {
      console.error('[SongComments]', err);
      sendJSON(res, { error: err.message, comments: [] }, 500);
    }
    return;
  }

  // ---------- 歌手主页 / 热门歌曲 ----------
  if (pn === '/api/artist/detail') {
    try {
      const id = url.searchParams.get('id');
      const limit = Math.max(10, Math.min(80, parseInt(url.searchParams.get('limit') || '30', 10) || 30));
      if (!id) { sendJSON(res, { error: 'Missing artist id', songs: [] }, 400); return; }
      let detailBody = {};
      try {
        const detail = await artist_detail({ id, cookie: userCookie, timestamp: Date.now() });
        detailBody = detail.body || detail || {};
      } catch (e) {
        console.warn('[ArtistDetail] detail failed:', e.message);
      }
      let rawSongs = [];
      try {
        const list = await artist_songs({ id, order: 'hot', limit, offset: 0, cookie: userCookie, timestamp: Date.now() });
        const b = list.body || list || {};
        rawSongs = (b.songs || (b.data && b.data.songs) || []);
      } catch (e) {
        console.warn('[ArtistSongs] hot failed:', e.message);
      }
      if (!rawSongs.length) {
        const top = await artist_top_song({ id, cookie: userCookie, timestamp: Date.now() });
        const b = top.body || top || {};
        rawSongs = b.songs || [];
      }
      const artist = detailBody.artist || (detailBody.data && (detailBody.data.artist || detailBody.data)) || {};
      const songs = rawSongs.map(mapSongRecord).filter(s => s.id).slice(0, limit);
      sendJSON(res, {
        id,
        artist: {
          id: artist.id || id,
          name: artist.name || artist.artistName || '',
          avatar: artist.avatar || artist.cover || artist.picUrl || artist.img1v1Url || '',
          brief: artist.briefDesc || artist.description || artist.desc || '',
          musicSize: artist.musicSize || artist.songSize || 0,
          albumSize: artist.albumSize || 0,
        },
        songs,
        body: detailBody,
      });
    } catch (err) {
      console.error('[ArtistDetail]', err);
      sendJSON(res, { error: err.message, songs: [] }, 500);
    }
    return;
  }

  // ---------- 歌单曲目详情 ----------
  if (pn === '/api/playlist/tracks') {
    try {
      const id = url.searchParams.get('id');
      if (!id) { sendJSON(res, { error: 'Missing playlist id', tracks: [] }, 400); return; }

      let playlistMeta = { id, name: '', cover: '', trackCount: 0 };
      let rawTracks = [];

      // 新版本 NeteaseCloudMusicApi 通常提供 playlist_track_all；旧版本退回 playlist_detail。
      if (typeof playlist_track_all === 'function') {
        try {
          const all = await playlist_track_all({ id, limit: 500, offset: 0, cookie: userCookie, timestamp: Date.now() });
          rawTracks = (all.body && (all.body.songs || all.body.tracks)) || [];
        } catch (err) {
          console.warn('[PlaylistTracks] playlist_track_all failed, fallback to detail:', err.message);
        }
      }

      if (!rawTracks.length && typeof playlist_detail === 'function') {
        const detail = await playlist_detail({ id, s: 0, cookie: userCookie, timestamp: Date.now() });
        const pl = (detail.body && detail.body.playlist) || {};
        playlistMeta = { id: pl.id || id, name: pl.name || '', cover: pl.coverImgUrl || '', trackCount: pl.trackCount || 0 };
        rawTracks = pl.tracks || [];
      }

      const tracks = rawTracks.map(mapSongRecord).filter(t => t.id);

      if (!playlistMeta.trackCount) playlistMeta.trackCount = tracks.length;
      sendJSON(res, { playlist: playlistMeta, tracks });
    } catch (err) {
      console.error('[PlaylistTracks]', err);
      sendJSON(res, { error: err.message, tracks: [] }, 500);
    }
    return;
  }

  // ---------- 封面代理 (带 CORS 头, 给 canvas 提取像素用) ----------
  if (pn === '/api/cover') {
    try {
      const coverUrl = url.searchParams.get('url');
      // URL 校验: 必须是 http(s) 开头, 否则直接 404 (不要让 fetch 抛错)
      if (!coverUrl || !/^https?:\/\//i.test(coverUrl)) {
        res.writeHead(400, { 'Access-Control-Allow-Origin': '*' });
        res.end('Invalid cover url');
        return;
      }
      const resp = await fetch(coverUrl, { headers: { 'User-Agent': UA, 'Referer': 'https://music.163.com/' } });
      const ct  = resp.headers.get('content-type') || 'image/jpeg';
      const cl  = resp.headers.get('content-length');
      const hdr = {
        'Content-Type': ct,
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Cache-Control': 'public, max-age=86400',
      };
      if (cl) hdr['Content-Length'] = cl;
      res.writeHead(resp.status, hdr);
      const reader = resp.body.getReader();
      while (true) { const c = await reader.read(); if (c.done) break; res.write(c.value); }
      res.end();
    } catch (err) { console.error('[Cover]', err); res.writeHead(500); res.end(); }
    return;
  }

  // ---------- 音频代理 (支持 Range) ----------
  if (pn === '/api/soda/audio') {
    const id = url.searchParams.get('id') || url.searchParams.get('trackId') || url.searchParams.get('track_id') || '';
    const quality = url.searchParams.get('quality') || '';
    await streamSodaAudio(req, res, id, quality);
    return;
  }

  if (pn === '/api/audio') {
    try {
      const audioUrl = url.searchParams.get('url');
      if (!audioUrl) { res.writeHead(400); res.end('Missing url'); return; }
      const range = req.headers.range || '';
      const hdr = audioProxyHeadersFor(audioUrl, range);
      const up = await fetch(audioUrl, { headers: hdr });
      const out = {
        'Content-Type': audioContentTypeForUrl(audioUrl, up.headers.get('content-type')),
        'Access-Control-Allow-Origin': '*',
        'Accept-Ranges': 'bytes',
      };
      const cl = up.headers.get('content-length'); if (cl) out['Content-Length'] = cl;
      const cr = up.headers.get('content-range');  if (cr) out['Content-Range']  = cr;
      res.writeHead(up.status, out);
      const reader = up.body.getReader();
      while (true) { const c = await reader.read(); if (c.done) break; res.write(c.value); }
      res.end();
    } catch (err) { console.error('[Audio]', err); res.writeHead(500); res.end(); }
    return;
  }

  // ---------- 静态资源 ----------
  if (pn === '/favicon.ico') {
    serveStatic(res, path.join(__dirname, 'build', 'icon.ico'));
    return;
  }

  let filePath = pn === '/' ? '/index.html' : pn;
  filePath = path.join(__dirname, 'public', filePath);
  serveStatic(res, filePath);
});

server.listen(PORT, HOST, () => {
  console.log('======================================================');
  console.log(' 粒子音乐可视化 v2  →  http://localhost:' + PORT);
  console.log(' 登录态: ' + (userCookie ? '已登录(cookie已加载)' : '未登录'));
  console.log('======================================================');
});

module.exports = server;
