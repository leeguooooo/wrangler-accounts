'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createShadowHome,
  cleanupShadow,
  buildIsolatedEnv,
  runIsolated,
} = require('../lib/isolation');

function mkFakeRealHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-fakehome-'));
  fs.writeFileSync(path.join(home, '.npmrc'), 'registry=https://example.com\n');
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n');
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.writeFileSync(path.join(home, '.ssh', 'config'), 'Host example\n');
  fs.mkdirSync(path.join(home, 'projects'));
  fs.writeFileSync(path.join(home, 'projects', 'foo.txt'), 'x');
  return home;
}

function mkProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-profile-'));
  fs.mkdirSync(path.join(dir, 'work'));
  fs.writeFileSync(
    path.join(dir, 'work', 'config.toml'),
    'oauth_token = "fake"\n',
  );
  return { profilesDir: dir, profileCfg: path.join(dir, 'work', 'config.toml') };
}

test('shadow HOME mirrors every top-level entry except .wrangler', () => {
  const realHome = mkFakeRealHome();
  const { profileCfg } = mkProfile();
  const shadow = createShadowHome({ realHome, profileCfg });
  try {
    const entries = fs.readdirSync(shadow).sort();
    assert.ok(entries.includes('.npmrc'));
    assert.ok(entries.includes('.gitconfig'));
    assert.ok(entries.includes('.ssh'));
    assert.ok(entries.includes('projects'));
    assert.ok(entries.includes('.wrangler'));
    // top-level entries are symlinks
    assert.equal(fs.lstatSync(path.join(shadow, '.npmrc')).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(path.join(shadow, 'projects')).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(path.join(shadow, '.ssh')).isSymbolicLink(), true);
    // .wrangler is a real dir, not a symlink
    assert.equal(fs.lstatSync(path.join(shadow, '.wrangler')).isSymbolicLink(), false);
    // symlinked entries read through to real content
    assert.match(fs.readFileSync(path.join(shadow, '.npmrc'), 'utf8'), /example\.com/);
    assert.equal(fs.readFileSync(path.join(shadow, 'projects', 'foo.txt'), 'utf8'), 'x');
  } finally {
    cleanupShadow(shadow);
  }
});

test('shadow .wrangler/config/default.toml symlinks to profile config', () => {
  const realHome = mkFakeRealHome();
  const { profileCfg } = mkProfile();
  const shadow = createShadowHome({ realHome, profileCfg });
  try {
    const linkPath = path.join(shadow, '.wrangler', 'config', 'default.toml');
    const stat = fs.lstatSync(linkPath);
    assert.equal(stat.isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(linkPath), profileCfg);
    assert.equal(fs.readFileSync(linkPath, 'utf8'), 'oauth_token = "fake"\n');
  } finally {
    cleanupShadow(shadow);
  }
});

test('shadow HOME skips .wrangler when real HOME has one', () => {
  const realHome = mkFakeRealHome();
  fs.mkdirSync(path.join(realHome, '.wrangler'));
  fs.writeFileSync(path.join(realHome, '.wrangler', 'marker.txt'), 'legacy');
  const { profileCfg } = mkProfile();
  const shadow = createShadowHome({ realHome, profileCfg });
  try {
    // shadow .wrangler must NOT expose the legacy marker file
    assert.equal(fs.existsSync(path.join(shadow, '.wrangler', 'marker.txt')), false);
    // shadow .wrangler should be a real dir, not a symlink to real HOME's
    assert.equal(
      fs.lstatSync(path.join(shadow, '.wrangler')).isSymbolicLink(),
      false,
    );
  } finally {
    cleanupShadow(shadow);
  }
});

test('shadow HOME has mode 0o700', () => {
  const realHome = mkFakeRealHome();
  const { profileCfg } = mkProfile();
  const shadow = createShadowHome({ realHome, profileCfg });
  try {
    const mode = fs.statSync(shadow).mode & 0o777;
    assert.equal(mode, 0o700);
  } finally {
    cleanupShadow(shadow);
  }
});

test('cleanupShadow removes the shadow dir', () => {
  const realHome = mkFakeRealHome();
  const { profileCfg } = mkProfile();
  const shadow = createShadowHome({ realHome, profileCfg });
  cleanupShadow(shadow);
  assert.equal(fs.existsSync(shadow), false);
});

test('cleanupShadow does not touch real HOME through symlinks', () => {
  const realHome = mkFakeRealHome();
  const { profileCfg } = mkProfile();
  const shadow = createShadowHome({ realHome, profileCfg });
  cleanupShadow(shadow);
  // real HOME's files must still exist (fs.rmSync does not follow symlinks)
  assert.equal(fs.existsSync(path.join(realHome, '.npmrc')), true);
  assert.equal(fs.existsSync(path.join(realHome, 'projects', 'foo.txt')), true);
  assert.equal(fs.existsSync(path.join(realHome, '.ssh', 'config')), true);
});

test('token refresh through the symlink writes back to the profile file', () => {
  const realHome = mkFakeRealHome();
  const { profileCfg } = mkProfile();
  const shadow = createShadowHome({ realHome, profileCfg });
  try {
    const linkPath = path.join(shadow, '.wrangler', 'config', 'default.toml');
    // Simulate wrangler refreshing the token. fs.writeFileSync writes in
    // place (open + write + close), so it follows the symlink and updates
    // the profile file directly.
    fs.writeFileSync(linkPath, 'oauth_token = "refreshed"\n');
    // profile file must reflect the refresh
    assert.equal(
      fs.readFileSync(profileCfg, 'utf8'),
      'oauth_token = "refreshed"\n',
    );
  } finally {
    cleanupShadow(shadow);
  }
});

test('createShadowHome throws when realHome does not exist', () => {
  const { profileCfg } = mkProfile();
  assert.throws(
    () => createShadowHome({ realHome: '/nonexistent/abc123', profileCfg }),
    /real HOME does not exist/,
  );
});

test('createShadowHome throws when profileCfg does not exist', () => {
  const realHome = mkFakeRealHome();
  assert.throws(
    () => createShadowHome({ realHome, profileCfg: '/nonexistent/cfg.toml' }),
    /profile config does not exist/,
  );
});

test('buildIsolatedEnv sets HOME, WRANGLER_PROFILE, and pass-through paths', () => {
  const env = buildIsolatedEnv({
    shadow: '/tmp/fake-shadow',
    realHome: '/Users/fake',
    profile: 'work',
    baseEnv: { PATH: '/usr/bin', FOO: 'bar' },
  });
  assert.equal(env.HOME, '/tmp/fake-shadow');
  assert.equal(env.WRANGLER_PROFILE, 'work');
  assert.equal(env.WRANGLER_ACCOUNT, 'work');
  assert.equal(env.WRANGLER_ACCOUNT_REAL_HOME, '/Users/fake');
  assert.equal(env.WRANGLER_REGISTRY_PATH, '/Users/fake/.wrangler/registry');
  assert.equal(env.WRANGLER_LOG_PATH, '/Users/fake/.wrangler/logs');
  assert.equal(env.WRANGLER_SEND_METRICS, 'false');
  // WRANGLER_CACHE_DIR is intentionally NOT set when profileCfg is omitted
  // (would otherwise force all callers into one shared global cache)
  assert.equal('WRANGLER_CACHE_DIR' in env, false);
  // base env preserved
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.FOO, 'bar');
});

test('buildIsolatedEnv includes CLOUDFLARED_PATH only when provided', () => {
  const envWith = buildIsolatedEnv({
    shadow: '/a',
    realHome: '/b',
    profile: 'w',
    baseEnv: {},
    cloudflaredPath: '/usr/local/bin/cloudflared',
  });
  assert.equal(envWith.CLOUDFLARED_PATH, '/usr/local/bin/cloudflared');

  const envWithout = buildIsolatedEnv({
    shadow: '/a',
    realHome: '/b',
    profile: 'w',
    baseEnv: {},
  });
  assert.equal('CLOUDFLARED_PATH' in envWithout, false);
});

test('buildIsolatedEnv sets WRANGLER_CACHE_DIR per-profile when profileCfg provided', () => {
  const realHome = mkFakeRealHome();
  const { profileCfg } = mkProfile();
  const env = buildIsolatedEnv({
    shadow: '/tmp/fake-shadow',
    realHome,
    profile: 'work',
    profileCfg,
    baseEnv: {},
  });
  // cache must be next to the profile config, NOT under real home
  const expected = path.join(path.dirname(profileCfg), 'cache');
  assert.equal(env.WRANGLER_CACHE_DIR, expected);
  assert.notEqual(env.WRANGLER_CACHE_DIR, path.join(realHome, '.wrangler', 'cache'));
  // and the dir should exist (so wrangler doesn't ENOENT writing wrangler-account.json)
  assert.equal(fs.existsSync(env.WRANGLER_CACHE_DIR), true);
});

test('buildIsolatedEnv omits WRANGLER_CACHE_DIR when profileCfg not provided', () => {
  // Lets wrangler use its own discovery (cwd-based), important for callers
  // that don't have a profile context yet.
  const env = buildIsolatedEnv({
    shadow: '/a',
    realHome: '/b',
    profile: 'w',
    baseEnv: {},
  });
  assert.equal('WRANGLER_CACHE_DIR' in env, false);
});

test('REGRESSION: two profiles get separate cache dirs (no account-id leak)', () => {
  // The 1.2.1 bug: WRANGLER_CACHE_DIR pointed at $realHome/.wrangler/cache
  // for every profile, so wrangler-account.json from profile A could be
  // read by profile B. Verify each profile gets its own cache.
  const realHome = mkFakeRealHome();
  const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-regress-'));
  fs.mkdirSync(path.join(profilesDir, 'A'));
  fs.writeFileSync(path.join(profilesDir, 'A', 'config.toml'), 'oauth_token = "a"\n');
  fs.mkdirSync(path.join(profilesDir, 'B'));
  fs.writeFileSync(path.join(profilesDir, 'B', 'config.toml'), 'oauth_token = "b"\n');

  const envA = buildIsolatedEnv({
    shadow: '/a',
    realHome,
    profile: 'A',
    profileCfg: path.join(profilesDir, 'A', 'config.toml'),
    baseEnv: {},
  });
  const envB = buildIsolatedEnv({
    shadow: '/b',
    realHome,
    profile: 'B',
    profileCfg: path.join(profilesDir, 'B', 'config.toml'),
    baseEnv: {},
  });
  assert.notEqual(envA.WRANGLER_CACHE_DIR, envB.WRANGLER_CACHE_DIR);
  assert.equal(envA.WRANGLER_CACHE_DIR, path.join(profilesDir, 'A', 'cache'));
  assert.equal(envB.WRANGLER_CACHE_DIR, path.join(profilesDir, 'B', 'cache'));
});

test('runIsolated spawns child with shadow HOME and correct env', () => {
  const realHome = mkFakeRealHome();
  const { profileCfg } = mkProfile();
  const outFile = path.join(os.tmpdir(), `wa-out-${Date.now()}-${Math.random()}.json`);
  const fakeWrangler = path.join(__dirname, 'fixtures', 'fake-wrangler.sh');

  const result = runIsolated({
    profile: 'work',
    profileCfg,
    realHome,
    command: fakeWrangler,
    args: ['deploy', '--env', 'production'],
    baseEnv: { ...process.env, WA_TEST_OUT: outFile, PATH: process.env.PATH },
  });

  assert.equal(result.exitCode, 0);
  const payload = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  // child's HOME is a shadow, not the real one
  assert.ok(payload.home.startsWith(os.tmpdir()));
  assert.notEqual(payload.home, realHome);
  assert.deepEqual(payload.argv, ['deploy', '--env', 'production']);
  assert.equal(payload.env.WRANGLER_PROFILE, 'work');
  assert.equal(payload.env.WRANGLER_ACCOUNT, 'work');
  assert.equal(payload.env.WRANGLER_REGISTRY_PATH, path.join(realHome, '.wrangler/registry'));
  // WRANGLER_CACHE_DIR is per-profile (next to the profile config), NOT
  // shared under realHome — see "REGRESSION: two profiles get separate
  // cache dirs" test for the rationale.
  assert.equal(payload.env.WRANGLER_CACHE_DIR, path.join(path.dirname(profileCfg), 'cache'));
  assert.notEqual(payload.env.WRANGLER_CACHE_DIR, path.join(realHome, '.wrangler/cache'));
  assert.equal(payload.env.WRANGLER_SEND_METRICS, 'false');
  // shadow HOME should be cleaned up after runIsolated returns
  assert.equal(fs.existsSync(payload.home), false);

  fs.unlinkSync(outFile);
});

test('runIsolated forwards child exit code', () => {
  const realHome = mkFakeRealHome();
  const { profileCfg } = mkProfile();
  const result = runIsolated({
    profile: 'work',
    profileCfg,
    realHome,
    command: 'sh',
    args: ['-c', 'exit 42'],
    baseEnv: { ...process.env },
  });
  assert.equal(result.exitCode, 42);
});

test('runIsolated cleans up shadow on non-zero child exit', () => {
  const realHome = mkFakeRealHome();
  const { profileCfg } = mkProfile();
  const outFile = path.join(os.tmpdir(), `wa-out-nonzero-${Date.now()}.txt`);
  runIsolated({
    profile: 'work',
    profileCfg,
    realHome,
    command: 'sh',
    args: ['-c', `echo $HOME > ${outFile}; exit 7`],
    baseEnv: { ...process.env },
  });
  const shadowPath = fs.readFileSync(outFile, 'utf8').trim();
  assert.equal(fs.existsSync(shadowPath), false, 'shadow should be cleaned up even on non-zero exit');
  fs.unlinkSync(outFile);
});

test('two runIsolated calls with the same profile get different shadow HOMEs', () => {
  const realHome = mkFakeRealHome();
  const { profileCfg } = mkProfile();
  const out1 = path.join(os.tmpdir(), `wa-r1-${Date.now()}.txt`);
  const out2 = path.join(os.tmpdir(), `wa-r2-${Date.now()}.txt`);
  runIsolated({
    profile: 'work', profileCfg, realHome,
    command: 'sh', args: ['-c', `echo $HOME > ${out1}`],
    baseEnv: { ...process.env },
  });
  runIsolated({
    profile: 'work', profileCfg, realHome,
    command: 'sh', args: ['-c', `echo $HOME > ${out2}`],
    baseEnv: { ...process.env },
  });
  const home1 = fs.readFileSync(out1, 'utf8').trim();
  const home2 = fs.readFileSync(out2, 'utf8').trim();
  assert.notEqual(home1, home2, 'each invocation should get its own shadow');
  fs.unlinkSync(out1);
  fs.unlinkSync(out2);
});
