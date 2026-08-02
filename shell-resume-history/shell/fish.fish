function __pi_shell_resume_history_setup
    if test "$PI_SHELL_RESUME_HISTORY_OWNER_PID" = "$fish_pid"; and test -d "$PI_SHELL_RESUME_HISTORY_DIR"
        return 0
    end

    set -l runtime_dir /tmp
    if set -q XDG_RUNTIME_DIR; and test -d "$XDG_RUNTIME_DIR"
        set runtime_dir "$XDG_RUNTIME_DIR"
    else if set -q TMPDIR; and test -d "$TMPDIR"
        set runtime_dir "$TMPDIR"
    end

    set -l inbox (command mktemp -d -- "$runtime_dir/pi-shell-resume-history.$fish_pid.XXXXXX")
    or return 1

    set -gx PI_SHELL_RESUME_HISTORY_DIR "$inbox"
    set -gx PI_SHELL_RESUME_HISTORY_OWNER_PID "$fish_pid"
end

function __pi_shell_resume_history_drain
    if test "$PI_SHELL_RESUME_HISTORY_OWNER_PID" != "$fish_pid"; or not test -d "$PI_SHELL_RESUME_HISTORY_DIR"
        return 0
    end

    for message in "$PI_SHELL_RESUME_HISTORY_DIR"/*.command
        set -l line
        if read -l line <"$message"; and test -n "$line"
            builtin history append -- "$line"
            or continue
        end
        command rm -f -- "$message"
    end
end

function __pi_shell_resume_history_on_prompt --on-event fish_prompt
    __pi_shell_resume_history_drain
end

function __pi_shell_resume_history_cleanup --on-process-exit %self
    if test "$PI_SHELL_RESUME_HISTORY_OWNER_PID" = "$fish_pid"; and test -n "$PI_SHELL_RESUME_HISTORY_DIR"
        command rm -rf -- "$PI_SHELL_RESUME_HISTORY_DIR"
        set -e PI_SHELL_RESUME_HISTORY_DIR
        set -e PI_SHELL_RESUME_HISTORY_OWNER_PID
    end
end

if status is-interactive
    __pi_shell_resume_history_setup
end
