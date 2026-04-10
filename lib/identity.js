'use strict';

const { spawnSync: defaultSpawnSync } = require('node:child_process');
const path = require('node:path');

const { resolvePath, detectConfigPath } = require('./paths');
const { listProfiles, readMeta } = require('./profile-store');

function parseWranglerWhoamiOutput(output) {
  const text = output || '';
  const emailMatch = text.match(/associated with the email ([^\n]+?)\.\s*$/m);
  const rowRegex = /│\s*(.+?)\s*│\s*([a-f0-9]{32})\s*│/g;
  const rows = [...text.matchAll(rowRegex)];
  const row = rows[0];

  if (!emailMatch && !row) return null;

  return {
    email: emailMatch ? emailMatch[1].trim() : null,
    accountName: row ? row[1].trim() : null,
    accountId: row ? row[2].trim() : null,
  };
}

function getWranglerAuthPath(env = process.env) {
  return detectConfigPath(undefined, env);
}

function canInspectIdentity(configPath, env = process.env) {
  return resolvePath(configPath) === resolvePath(getWranglerAuthPath(env));
}

function getCurrentIdentity(configPath, { env = process.env, spawn = defaultSpawnSync } = {}) {
  if (!canInspectIdentity(configPath, env)) {
    return {
      identity: null,
      error: `Identity lookup only works for the active Wrangler auth file: ${getWranglerAuthPath(env)}`,
    };
  }

  const result = spawn('wrangler', ['whoami'], { encoding: 'utf8' });

  if (result.error) {
    return { identity: null, error: result.error.message };
  }

  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status !== 0) {
    return {
      identity: null,
      error: output.includes('Not logged in')
        ? 'Not logged in'
        : `wrangler whoami exited with code ${result.status}`,
    };
  }

  const identity = parseWranglerWhoamiOutput(output);
  if (!identity) {
    return { identity: null, error: "Failed to parse 'wrangler whoami' output" };
  }

  return { identity, error: null };
}

function getMetaIdentity(meta) {
  if (!meta || !meta.identity) return null;
  const { email = null, accountName = null, accountId = null } = meta.identity;
  if (!email && !accountName && !accountId) return null;
  return { email, accountName, accountId };
}

function identitiesMatch(left, right) {
  if (!left || !right) return false;
  if (left.accountId && right.accountId) return left.accountId === right.accountId;
  if (left.email && right.email) return left.email === right.email;
  return false;
}

function describeIdentity(identity) {
  if (!identity) return 'unknown';
  const parts = [];
  if (identity.email) parts.push(identity.email);
  if (identity.accountId) parts.push(identity.accountId);
  return parts.join(' / ') || 'unknown';
}

function findProfilesByIdentity(profilesDir, identity, { includeBackups = false } = {}) {
  if (!identity) return [];
  const profiles = listProfiles(profilesDir, { includeBackups });
  return profiles.filter((name) => {
    const meta = readMeta(path.join(profilesDir, name));
    return identitiesMatch(identity, getMetaIdentity(meta));
  });
}

module.exports = {
  parseWranglerWhoamiOutput,
  getWranglerAuthPath,
  canInspectIdentity,
  getCurrentIdentity,
  getMetaIdentity,
  identitiesMatch,
  describeIdentity,
  findProfilesByIdentity,
};
