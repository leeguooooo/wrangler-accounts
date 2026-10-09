'use strict';

// Cloudflare `cf` support: running cf under a profile, exec wrappers, the
// guard hook and the PATH shim. Cloud Foundry's `cf` must never be touched.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { isCloudflareCf, findCloudflareCf } = require('../lib/cf');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'wrangler-accounts.js');
const NATIVE_BIN = path.join(__dirname, 'fixtures', 'native-bin');
const CF_BIN = path.join(__dirname, 'fixtures', 'cf-pkg', 'bin');
const CF_REAL = path.join(__dirname, 'fixtures', 'cf-pkg', 'cf', 'bin', 'cf');
const CLOUDFOUNDRY_BIN = path.join(__dirname, 'fixtures', 'cloudfoundry-bin');
const HOOK = path.join(ROOT, 'plugins', 'wrangler-accounts', 'hooks', 'guard-wrangler.sh');

const TOML = 'oauth_token = "tok"\nrefresh_token = "r"\nexpiration_time = "2099-01-01T00:00:00.000Z"\n';

function setup(pathDirs) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cf-')));
  const home = path.join(root, 'home');
  const profiles = path.join(root, 'profiles');
  fs.mkdirSync(path.join(home, '.wrangler', 'config'), { recursive: true });
  // a CLI shim so the hook / shim can call `wrangler-accounts`
  const waBin = path.join(root, 'wa-bin');
  fs.mkdirSync(waBin);
  fs.writeFileSync(path.join(waBin, 'wrangler-accounts'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
  const env = {
    PATH: [...pathDirs, waBin, NATIVE_BIN, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    HOME: home,
    WA_TEST_REAL_HOME: home,
    WRANGLER_ACCOUNTS_DIR: profiles,
    WRANGLER_ACCOUNTS_SECRET_BACKEND: `file:${path.join(root, 'store')}`,
    WRANGLER_ACCOUNTS_SHIM_DIR: path.join(root, 'shims'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    SHELL: '/bin/sh',
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
  };
  const t = { root, home, profiles, env, waBin };
  t.run = (args, extra = {}) =>
    spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...env, ...extra }, cwd: root, input: '' });
  t.addOAuth = (name, meta = {}) => {
    fs.mkdirSync(path.join(profiles, name), { recursive: true });
    fs.writeFileSync(path.join(profiles, name, 'config.toml'), TOML);
    fs.writeFileSync(path.join(profiles, name, 'meta.json'), JSON.stringify({ name, identity: { accountId: 'acct-oauth' }, ...meta }));
  };
  t.addToken = (name) => {
    fs.mkdirSync(path.join(profiles, name), { recursive: true });
    fs.writeFileSync(path.join(profiles, name, 'token.json'), JSON.stringify({ apiToken: `api-${name}`, accountId: `acct-${name}` }));
  };
  t.cfLogin = (name) => {
    const dir = path.join(home, '.config', 'cloudflare', 'config');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.json`), '{"oauth_token":"cf"}');
  };
  return t;
}

test('Cloudflare cf is recognised by its package.json; Cloud Foundry is not', () => {
  assert.equal(isCloudflareCf(path.join(CF_BIN, 'cf')), true);
  assert.equal(isCloudflareCf(path.join(CF_BIN, 'cloudflare')), true);
  assert.equal(isCloudflareCf(path.join(CLOUDFOUNDRY_BIN, 'cf')), false);
  // Cloud Foundry first on PATH: use the `cloudflare` alias, report the other cf
  const found = findCloudflareCf({ pathEnv: [CLOUDFOUNDRY_BIN, CF_BIN].join(path.delimiter) });
  assert.equal(found.via, 'cloudflare');
  assert.equal(found.other, path.join(CLOUDFOUNDRY_BIN, 'cf'));
  assert.equal(findCloudflareCf({ pathEnv: CLOUDFOUNDRY_BIN }).path, null);
});

test('--profile <token> cf ...: token and account id in the environment, no --profile', () => {
  const t = setup([CF_BIN]);
  t.addToken('ci');
  const r = t.run(['--profile', 'ci', 'cf', 'zones', 'list'], { CLOUDFLARE_API_TOKEN: 'leak' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.tool, 'cloudflare-cf');
  assert.deepEqual(out.argv, ['zones', 'list']);
  assert.equal(out.env.CLOUDFLARE_API_TOKEN, 'api-ci');
  assert.equal(out.env.CLOUDFLARE_ACCOUNT_ID, 'acct-ci');
});

test('--profile <oauth> cf ...: uses cf --profile when cf has that login, else explains', () => {
  const t = setup([CF_BIN]);
  t.addOAuth('work');
  const missing = t.run(['--profile', 'work', 'cf', 'zones', 'list']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /cf auth create work/);
  assert.match(missing.stderr, /cf 还没有/);

  t.cfLogin('work');
  const r = t.run(['--profile', 'work', 'cf', 'zones', 'list'], { CLOUDFLARE_API_TOKEN: 'leak' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.argv, ['zones', 'list', '--profile', 'work']);
  assert.equal(out.env.CLOUDFLARE_API_TOKEN, null);
  assert.equal(out.env.CLOUDFLARE_ACCOUNT_ID, 'acct-oauth');
  // `cf auth ...` is account management: passed through without --profile
  assert.deepEqual(JSON.parse(t.run(['work', 'cf', 'auth', 'create', 'work']).stdout).argv, ['auth', 'create', 'work']);
  assert.deepEqual(JSON.parse(t.run(['work', 'cf', 'auth', 'whoami']).stdout).argv, ['auth', 'whoami', '--profile', 'work']);
});

test('cf for a migrated profile uses the wrangler-compatible native name', () => {
  const t = setup([CF_BIN]);
  t.addOAuth('acme.prod');
  const m = t.run(['migrate', 'acme.prod', '--json']);
  assert.equal(m.status, 0, m.stderr);
  t.cfLogin('acme-prod');
  const out = JSON.parse(t.run(['--profile', 'acme.prod', 'cf', 'dns']).stdout);
  assert.deepEqual(out.argv, ['dns', '--profile', 'acme-prod']);
});

test('exec <name> -- cf ... runs Cloudflare cf under the profile; Cloud Foundry cf is left alone', () => {
  const t = setup([CF_BIN]);
  t.addToken('ci');
  const r = t.run(['exec', 'ci', '--', 'cf', 'whoami']);
  assert.equal(JSON.parse(r.stdout).env.CLOUDFLARE_API_TOKEN, 'api-ci');

  const cfDirect = t.run(['exec', 'ci', '--', CF_REAL, 'x']);
  assert.equal(JSON.parse(cfDirect.stdout).tool, 'cloudflare-cf');

  const foundry = setup([CLOUDFOUNDRY_BIN]);
  foundry.addToken('ci');
  const push = foundry.run(['exec', 'ci', '--', 'cf', 'push', 'app']);
  assert.equal(push.status, 0, push.stderr);
  assert.equal(push.stdout.trim(), 'cloudfoundry-cf push app');
  const blocked = foundry.run(['--profile', 'ci', 'cf', 'push']);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /Cloud Foundry/);
});

test('inside an OAuth exec subshell a bare cf gets --profile (or guidance)', () => {
  const t = setup([CF_BIN]);
  t.addOAuth('work');
  const none = t.run(['exec', 'work', '--', 'sh', '-c', 'cf zones list']);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /cf auth create work/);
  t.cfLogin('work');
  const ok = t.run(['exec', 'work', '--', 'sh', '-c', 'cf zones list'], { CLOUDFLARE_AUTH_USE_KEYRING: 'true' });
  assert.equal(ok.status, 0, ok.stderr);
  const out = JSON.parse(ok.stdout);
  assert.deepEqual(out.argv, ['zones', 'list', '--profile', 'work']);
  const who = JSON.parse(t.run(['exec', 'work', '--', 'sh', '-c', 'cf auth whoami']).stdout);
  assert.deepEqual(who.argv, ['auth', 'whoami', '--profile', 'work']);
  const create = JSON.parse(t.run(['exec', 'work', '--', 'sh', '-c', 'cf auth create other']).stdout);
  assert.deepEqual(create.argv, ['auth', 'create', 'other']);
  // cf gets the user's own keyring setting back, wrangler in the shadow gets "false"
  assert.equal(out.env.CLOUDFLARE_AUTH_USE_KEYRING, 'true');
});

test('__is-cloudflare-cf', () => {
  const t = setup([CF_BIN]);
  assert.equal(t.run(['__is-cloudflare-cf', path.join(CF_BIN, 'cf')]).status, 0);
  assert.equal(t.run(['__is-cloudflare-cf', path.join(CLOUDFOUNDRY_BIN, 'cf')]).status, 1);
  assert.equal(t.run(['__is-cloudflare-cf']).status, 0);
  assert.equal(setup([CLOUDFOUNDRY_BIN]).run(['__is-cloudflare-cf']).status, 1);
});

function guard(t, command, extraEnv = {}) {
  const cwd = fs.mkdtempSync(path.join(t.root, 'proj-'));
  fs.writeFileSync(path.join(cwd, 'wrangler.toml'), 'name = "demo"\n');
  return spawnSync('bash', [HOOK], {
    cwd,
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
    env: { ...t.env, NOWRANGLER_ACCOUNTS_GUARD: '', CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '', ...extraEnv },
  });
}

test('guard hook: blocks bare Cloudflare cf, never Cloud Foundry cf', () => {
  const t = setup([CF_BIN]);
  t.addOAuth('work');
  const r = guard(t, 'cf zones list');
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /wrangler-accounts --profile <name> cf/);
  assert.equal(guard(t, 'cf auth create work').status, 0);
  assert.equal(guard(t, 'cf --version').status, 0);
  assert.equal(guard(t, 'npx cf zones list').status, 0);
  assert.equal(guard(t, 'wrangler-accounts --profile work cf zones list').status, 0);

  const f = setup([CLOUDFOUNDRY_BIN]);
  f.addOAuth('work');
  assert.equal(guard(f, 'cf push my-app').status, 0);
});

test('guard hook: explicit --profile passes only without exported credentials; exec form passes', () => {
  const t = setup([CF_BIN]);
  t.addOAuth('work');
  assert.equal(guard(t, 'wrangler deploy').status, 2);
  assert.equal(guard(t, 'wrangler deploy --profile work').status, 0);
  assert.equal(guard(t, 'cf zones list --profile work').status, 0);
  assert.equal(guard(t, 'wrangler deploy --profile work', { CLOUDFLARE_ACCOUNT_ID: 'x' }).status, 2);
  assert.equal(guard(t, 'CLOUDFLARE_API_TOKEN=x wrangler deploy --profile work').status, 2);
  assert.equal(guard(t, 'wrangler-accounts exec work -- wrangler deploy').status, 0);
});

test('shim install adds a cf shim only for Cloudflare cf; it blocks Cloudflare cf and passes Cloud Foundry', () => {
  const t = setup([CF_BIN]);
  t.addOAuth('work');
  const out = JSON.parse(t.run(['shim', 'install', '--json']).stdout);
  assert.equal(out.cfShimPath, path.join(t.root, 'shims', 'cf'));
  const shimEnv = { ...t.env, PATH: `${path.join(t.root, 'shims')}${path.delimiter}${t.env.PATH}` };
  const blocked = spawnSync('cf', ['zones', 'list'], { env: shimEnv, encoding: 'utf8' });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /direct `cf` is blocked/);
  assert.equal(spawnSync('cf', ['--profile', 'work', 'zones'], { env: shimEnv, encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync('cf', ['auth', 'list'], { env: shimEnv, encoding: 'utf8' }).status, 0);
  assert.equal(JSON.parse(t.run(['shim', 'status', '--json']).stdout).cfShimInstalled, true);
  // the user later puts Cloud Foundry first: the cf shim steps aside
  const foundryEnv = { ...shimEnv, PATH: [path.join(t.root, 'shims'), CLOUDFOUNDRY_BIN, t.env.PATH].join(path.delimiter) };
  const push = spawnSync('cf', ['push', 'app'], { env: foundryEnv, encoding: 'utf8' });
  assert.equal(push.stdout.trim(), 'cloudfoundry-cf push app');
  t.run(['shim', 'uninstall']);
  assert.ok(!fs.existsSync(path.join(t.root, 'shims', 'cf')));

  const f = setup([CLOUDFOUNDRY_BIN]);
  assert.equal(JSON.parse(f.run(['shim', 'install', '--json']).stdout).cfShimPath, null);
  assert.ok(!fs.existsSync(path.join(f.root, 'shims', 'cf')));
});

test('wrangler shim: explicit --profile and `wrangler auth` pass through', () => {
  const t = setup([]);
  t.addOAuth('work');
  t.run(['shim', 'install']);
  const shimEnv = { ...t.env, PATH: `${path.join(t.root, 'shims')}${path.delimiter}${t.env.PATH}` };
  assert.equal(spawnSync('wrangler', ['deploy'], { env: shimEnv, encoding: 'utf8' }).status, 1);
  assert.equal(spawnSync('wrangler', ['auth', '--help'], { env: shimEnv, encoding: 'utf8' }).status, 0);
  fs.writeFileSync(path.join(t.home, '.wrangler', 'config', 'work.toml'), TOML);
  assert.equal(spawnSync('wrangler', ['deploy', '--profile', 'work'], { env: shimEnv, encoding: 'utf8' }).status, 0);
  assert.equal(
    spawnSync('wrangler', ['deploy', '--profile', 'work'], { env: { ...shimEnv, CLOUDFLARE_ACCOUNT_ID: 'x' }, encoding: 'utf8' }).status,
    1,
  );
});
