'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { isValidName, getDefaultProfile } = require('./profile-store');

class ResolveError extends Error {
  constructor(message, code = 'PROFILE_NOT_FOUND') {
    super(message);
    this.name = 'ResolveError';
    this.code = code;
  }
}

function profileExists(name, profilesDir) {
  return fs.existsSync(path.join(profilesDir, name, 'config.toml'));
}

function assertValid(name) {
  if (!isValidName(name)) {
    throw new ResolveError(`Invalid profile name: ${name}`, 'INVALID_NAME');
  }
}

function assertExists(name, profilesDir) {
  if (!profileExists(name, profilesDir)) {
    throw new ResolveError(`Profile not found: ${name}`, 'PROFILE_NOT_FOUND');
  }
}

/**
 * Resolve a profile name using AWS-style precedence.
 *
 * Order:
 *  1. Explicit `--profile <name>` / `-p <name>` (cliProfile)
 *  2. Positional shorthand — first positional arg, only when it matches a
 *     saved profile AND is not a management subcommand name
 *  3. `$WRANGLER_PROFILE`
 *  4. Persistent default from profilesDir/default
 *  5. Hard error with actionable hint
 *
 * @param {object} args
 * @param {string|null} args.cliProfile
 * @param {string|null} args.positional
 * @param {object} args.env
 * @param {string} args.profilesDir
 * @param {Set<string>} [args.managementSubcommands]
 * @returns {{ name: string, source: 'cli' | 'positional' | 'env' | 'default' }}
 * @throws ResolveError
 */
function resolveProfile({
  cliProfile,
  positional,
  env,
  profilesDir,
  managementSubcommands = new Set(),
}) {
  // 1. Explicit --profile / -p
  if (cliProfile) {
    assertValid(cliProfile);
    assertExists(cliProfile, profilesDir);
    return { name: cliProfile, source: 'cli' };
  }

  // 2. Positional shorthand
  if (positional && !managementSubcommands.has(positional)) {
    if (isValidName(positional) && profileExists(positional, profilesDir)) {
      return { name: positional, source: 'positional' };
    }
  }

  // 3. Env var
  const envProfile = env && env.WRANGLER_PROFILE;
  if (envProfile && envProfile.length) {
    assertValid(envProfile);
    assertExists(envProfile, profilesDir);
    return { name: envProfile, source: 'env' };
  }

  // 4. Persistent default
  const def = getDefaultProfile(profilesDir);
  if (def) {
    assertValid(def);
    assertExists(def, profilesDir);
    return { name: def, source: 'default' };
  }

  // 5. Error
  throw new ResolveError(
    [
      'No profile specified. Options:',
      '  - wrangler-accounts --profile <name> ...',
      '  - WRANGLER_PROFILE=<name> wrangler-accounts ...',
      '  - wrangler-accounts default <name>   (set a persistent default)',
    ].join('\n'),
    'NO_PROFILE',
  );
}

module.exports = { resolveProfile, ResolveError };
