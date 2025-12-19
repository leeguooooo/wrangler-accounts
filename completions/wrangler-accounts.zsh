#compdef wrangler-accounts

_wrangler_accounts() {
  local -a commands
  commands=(
    'list:List profiles'
    'status:Show status'
    'login:Login and save profile'
    'save:Save current profile'
    'use:Switch to profile'
    'remove:Remove profile'
  )

  local state
  _arguments -C \
    '1:command:->command' \
    '*::arg:->args'

  case $state in
    command)
      _describe 'command' commands
      return
      ;;
    args)
      case $words[1] in
        save|use|remove|login)
          local profiles
          profiles=(${(f)"$(wrangler-accounts list --plain 2>/dev/null | grep -v '^__backup-')"})
          _describe 'profiles' profiles
          ;;
      esac
      ;;
  esac
}

_wrangler_accounts "$@"
