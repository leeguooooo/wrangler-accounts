'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createShadowHome,
  cleanupShadow,
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
