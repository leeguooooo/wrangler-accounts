#compdef wrangler-accounts

_wrangler_accounts() {
  local -a commands
  commands=(
    'list:List profiles'
    'status:Show status'
    'login:Login and save a profile (isolated)'
    'save:Save current Wrangler config as a profile'
    'sync:Sync current login into a named profile'
    'sync-default:Sync current login into the default profile'
    'default:Get or set the persistent default profile'
    'whoami:Show identity for the resolved profile'
    'exec:Run a command in an isolated shadow HOME for a profile'
    'gc:Remove stale shadow HOMEs from tmpdir'
    'remove:Remove a profile'
    'use:(deprecated) Globally switch to a profile'
    'sync-active:(deprecated) Alias for sync-default'
  )

  _get_profiles() {
    local profiles
    profiles=(${(f)"$(wrangler-accounts list --plain 2>/dev/null | grep -v '^__backup-')"})
    _describe 'profiles' profiles
  }

  local state
  _arguments -C \
    '(-h --help)'{-h,--help}'[Show help]' \
    '--json[JSON output]' \
    '(--profile -p)'{--profile,-p}'[Profile name to use]:profile:->profile' \
    '--profiles[Profiles directory path]:path:_files -/' \
    '(-c --config)'{-c,--config}'[Wrangler config path]:path:_files' \
    '--include-backups[Include backup profiles]' \
    '(--force -f)'{--force,-f}'[Overwrite existing profile on save]' \
    '--no-backup[Disable backup on use]' \
    '--unset[Unset the persistent default profile]' \
    '--older-than[Age threshold for gc]:duration:' \
    '1:command:->command' \
    '*::arg:->args'

  case $state in
    command)
      _describe 'command' commands
      return
      ;;
    profile)
      _get_profiles
      return
      ;;
    args)
      case $words[1] in
        save|sync|login|remove|default|whoami|exec|use)
          _get_profiles
          ;;
      esac
      ;;
  esac
}

_wrangler_accounts "$@"
