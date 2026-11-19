function __pi_shell_resume_history_setup() {
  emulate -L zsh

  if [[ ${PI_SHELL_RESUME_HISTORY_OWNER_PID:-} == $$ &&
    -d ${PI_SHELL_RESUME_HISTORY_DIR:-} ]]; then
    return 0
  fi

  local runtime_dir=${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}
  [[ -d $runtime_dir ]] || runtime_dir=/tmp

  local inbox
  inbox=$(command mktemp -d -- "$runtime_dir/pi-shell-resume-history.$$.XXXXXX") ||
    return 1

  export PI_SHELL_RESUME_HISTORY_DIR=$inbox
  export PI_SHELL_RESUME_HISTORY_OWNER_PID=$$
}

function __pi_shell_resume_history_drain() {
  emulate -L zsh

  if [[ ${PI_SHELL_RESUME_HISTORY_OWNER_PID:-} != $$ ||
    ! -d ${PI_SHELL_RESUME_HISTORY_DIR:-} ]]; then
    return 0
  fi

  local message session_file
  for message in "$PI_SHELL_RESUME_HISTORY_DIR"/*.session-path(N); do
    if IFS= read -r -d '' session_file <"$message" && [[ -n $session_file ]]; then
      print -rs -- "pi --session ${(qqqq)session_file}" || continue
    fi
    command rm -f -- "$message"
  done
}

function __pi_shell_resume_history_cleanup() {
  emulate -L zsh

  if [[ ${PI_SHELL_RESUME_HISTORY_OWNER_PID:-} == $$ &&
    -n ${PI_SHELL_RESUME_HISTORY_DIR:-} ]]; then
    command rm -rf -- "$PI_SHELL_RESUME_HISTORY_DIR"
  fi
}

if [[ -o interactive ]]; then
  __pi_shell_resume_history_setup
  autoload -Uz add-zsh-hook
  add-zsh-hook precmd __pi_shell_resume_history_drain
  add-zsh-hook zshexit __pi_shell_resume_history_cleanup
fi
