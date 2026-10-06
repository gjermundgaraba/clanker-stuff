#!/usr/bin/env bash
# Adapted and hardened from mitsuhiko/agent-stuff; see SKILL.md metadata and LICENSE.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: checkout.sh <repo> [options]

Cache a repository under <cache-root>/<host[:port]>/<org>/<repo>.
Nested groups are supported. Explicit URLs keep their transport and SSH user.
Existing origins must identify the requested repository and are never rewritten.

Examples:
  checkout.sh mitsuhiko/minijinja
  checkout.sh github.com/mitsuhiko/minijinja
  checkout.sh https://github.com/mitsuhiko/minijinja
  checkout.sh git@github.com:mitsuhiko/minijinja.git
  checkout.sh ssh://git@git.example.com:2222/team/repo.git

Options:
  --path-only                 Print only the checkout path on success.
  --force-update              Require a clean checkout matching freshly fetched upstream.
  --update-interval <secs>     Minimum seconds between updates (default: 300).

Environment:
  LIBRARIAN_CACHE_ROOT        Override cache root (default: ~/.cache/checkouts)
  LIBRARIAN_DEFAULT_HOST      Host for owner/repo shorthand (default: github.com)
  LIBRARIAN_UPDATE_INTERVAL   Default update interval in seconds

Diagnostics go to stderr, including with --path-only. A forced refresh that
cannot complete exits nonzero without printing a checkout path. Ordinary
refreshes may reuse the cached revision with a warning when advancement is unsafe.
EOF
}

die() {
  printf 'error: %s\n' "$1" >&2
  exit "${2:-2}"
}

if [[ $# -lt 1 ]]; then
  usage >&2
  exit 2
fi

repo_input=""
path_only=0
force_update=0
update_interval="${LIBRARIAN_UPDATE_INTERVAL:-300}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --path-only) path_only=1; shift ;;
    --force-update) force_update=1; shift ;;
    --update-interval)
      [[ $# -ge 2 ]] || die '--update-interval expects a value'
      update_interval="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    -*) die 'unknown option (see --help)' ;;
    *)
      [[ -z "$repo_input" ]] || die 'expected one repository argument'
      repo_input="$1"
      shift
      ;;
  esac
done

[[ -n "$repo_input" ]] || die 'repository is required'
[[ "$update_interval" =~ ^[0-9]+$ && ${#update_interval} -le 10 ]] ||
  die 'update interval must be an integer between 0 and 2147483647'
update_interval=$((10#$update_interval))
(( update_interval <= 2147483647 )) || die 'update interval exceeds 2147483647 seconds'

# Sets parsed_host, parsed_path, and parsed_url only after complete validation.
# Keep this parser free of filesystem operations and avoid echoing credentials.
parse_repo() {
  local input="$1" authority path normalized_path first scheme="" user="" hostname port=""
  local transport="https" shorthand=0 part
  local parts=()
  input="${input#"${input%%[![:space:]]*}"}"
  input="${input%"${input##*[![:space:]]}"}"
  [[ -n "$input" && "$input" != *[[:cntrl:][:space:]]* ]] || return 1

  case "$input" in
    http://*|https://*|ssh://*)
      scheme="${input%%://*}"
      input="${input#*://}"
      # Queries/fragments belong to web links, not Git repository identities.
      if [[ "$scheme" != ssh ]]; then
        input="${input%%\?*}"
        input="${input%%#*}"
      fi
      [[ "$input" == */* ]] || return 1
      authority="${input%%/*}"
      path="${input#*/}"
      transport="$scheme"
      ;;
    *@*:* )
      authority="${input%%:*}"
      path="${input#*:}"
      transport="scp"
      ;;
    *://*) return 1 ;;
    */*)
      first="${input%%/*}"
      if [[ "$first" == *.* || "$first" == *:* || "$first" == localhost ]]; then
        authority="$first"
        path="${input#*/}"
      else
        authority="${LIBRARIAN_DEFAULT_HOST:-github.com}"
        path="$input"
      fi
      shorthand=1
      ;;
    *) return 1 ;;
  esac

  if [[ "$authority" == *@* ]]; then
    [[ "$transport" == ssh || "$transport" == scp ]] || return 1
    user="${authority%%@*}"
    authority="${authority#*@}"
    [[ "$user" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$ ]] || return 1
  fi
  hostname="${authority%%:*}"
  if [[ "$authority" == *:* ]]; then
    [[ "$transport" != scp ]] || return 1
    port="${authority#*:}"
    [[ "$port" =~ ^[0-9]{1,5}$ ]] || return 1
    port=$((10#$port))
    (( port > 0 && port <= 65535 )) || return 1
  fi
  # DNS names, IPv4 addresses, and SSH aliases; reject unsupported authorities.
  [[ "$hostname" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$ ]] || return 1
  [[ "$hostname" != *..* && "$hostname" != *. && "$hostname" != *- ]] || return 1
  hostname="$(printf '%s' "$hostname" | tr '[:upper:]' '[:lower:]')"
  authority="$hostname${port:+:$port}"

  path="${path%/}"
  [[ -n "$path" && "$path" != /* && "$path" != */ && "$path" != *//* ]] || return 1
  IFS='/' read -r -a parts <<< "$path"
  [[ ${#parts[@]} -ge 2 ]] || return 1
  for part in "${parts[@]}"; do
    [[ "$part" =~ ^[a-zA-Z0-9_.-]+$ && "$part" != . && "$part" != .. ]] || return 1
  done

  # Only GitHub web links have these owner/repo routes. Do not truncate nested
  # groups named tree, issues, etc. on other hosts or in explicit SSH references.
  if [[ "$hostname" == github.com && "$transport" != ssh && "$transport" != scp && ${#parts[@]} -ge 3 ]]; then
    case "${parts[2]}" in
      tree|blob|pull|issues|commit|actions|releases|compare|wiki)
        path="${parts[0]}/${parts[1]}"
        ;;
    esac
  fi

  normalized_path="${path%.git}"
  part="${normalized_path##*/}"
  [[ -n "$part" && "$part" != . && "$part" != .. ]] || return 1
  parsed_host="$authority"
  parsed_path="$normalized_path"
  if (( shorthand )); then
    path="$parsed_path.git"
  fi
  if [[ "$transport" == scp ]]; then
    parsed_url="${user:+$user@}$authority:$path"
  else
    parsed_url="$transport://${user:+$user@}$authority/$path"
  fi
}

parse_repo "$repo_input" || die 'invalid repository reference; use an HTTP(S) URL, SSH reference, or owner/repo without dot segments'
host="$parsed_host"
repo_path="$parsed_path"
origin_url="$parsed_url"

cache_root="${LIBRARIAN_CACHE_ROOT:-$HOME/.cache/checkouts}"
mkdir -p -- "$cache_root"
cache_root="$(cd -- "$cache_root" && pwd -P)"
checkout_path="${cache_root%/}/$host/$repo_path"

# The configured root may itself be a symlink. Below its physical location,
# reject symlinks before creating directories or running Git, including dangling
# links and aliases that would make two repository keys share one checkout.
IFS='/' read -r -a cache_parts <<< "$host/$repo_path"
checked_path="${cache_root%/}"
for part in "${cache_parts[@]}"; do
  checked_path="$checked_path/$part"
  [[ ! -L "$checked_path" ]] || die 'cache path contains a symlink; choose a separate cache location' 3
  [[ ! -e "$checked_path" || -d "$checked_path" ]] || die 'cache path contains a non-directory' 3
done

if [[ ! -e "$checkout_path" ]]; then
  mkdir -p -- "${checkout_path%/*}"
  git clone --filter=blob:none -- "$origin_url" "$checkout_path" >/dev/null || die 'repository clone failed' 3
  clone_state="cloned"
else
  clone_state="existing"
fi

[[ -d "$checkout_path/.git" && ! -L "$checkout_path/.git" ]] || die 'cache entry must be a standalone Git checkout' 3
[[ "$(git -C "$checkout_path" rev-parse --show-toplevel)" == "$checkout_path" ]] || die 'cache entry resolves to a different Git checkout' 3

# Compare the configured URL, before any user-configured Git insteadOf rewrite.
# Preserve working authentication/transport settings for the same logical repo.
current_origin="$(git -C "$checkout_path" config --get-all remote.origin.url)" || die 'cached checkout has no origin' 3
parse_repo "$current_origin" || die 'cached origin has an unsupported or ambiguous repository identity' 3
[[ "$parsed_host" == "$host" && "$parsed_path" == "$repo_path" ]] || die 'cached origin points to a different repository' 3

last_fetch_file="$checkout_path/.git/librarian-last-fetch"
[[ ! -L "$last_fetch_file" ]] || die 'cache timestamp must not be a symlink' 3
now_epoch="$(date +%s)"
needs_update=1
if [[ -f "$last_fetch_file" && "$force_update" -eq 0 ]]; then
  last_epoch="$(cat "$last_fetch_file")"
  if [[ "$last_epoch" =~ ^[0-9]{1,10}$ ]]; then
    age=$(( now_epoch - 10#$last_epoch ))
    if (( age >= 0 && age < update_interval )); then
      needs_update=0
    fi
  fi
fi

update_state="skipped"
ff_state="not-attempted"
refresh_checkout() {
  local branch dirty upstream_remote upstream_source fetch_specs fetch_spec upstream_oid head_oid
  branch="$(git -C "$checkout_path" symbolic-ref --short -q HEAD)" || {
    ff_state="skipped-detached"; return 1;
  }
  dirty="$(git -C "$checkout_path" status --porcelain --untracked-files=normal)" || die 'cannot inspect cached working tree' 3
  if [[ -n "$dirty" ]]; then
    ff_state="skipped-dirty"; return 1
  fi
  upstream_remote="$(git -C "$checkout_path" config --get "branch.$branch.remote")" || {
    ff_state="skipped-no-upstream"; return 1;
  }
  if [[ "$upstream_remote" != origin ]]; then
    ff_state="skipped-upstream-not-origin"; return 1
  fi
  upstream_source="$(git -C "$checkout_path" config --get-all "branch.$branch.merge")" || {
    ff_state="skipped-no-upstream"; return 1;
  }
  git check-ref-format "$upstream_source" >/dev/null || {
    ff_state="skipped-ambiguous-upstream"; return 1;
  }
  fetch_specs="$(git -C "$checkout_path" config --get-all remote.origin.fetch)" || {
    ff_state="skipped-no-fetch-mapping"; return 1;
  }
  # A negative refspec can exclude the upstream while leaving a stale tracking
  # ref that still resolves. Do not call that checkout fresh or override the
  # user's fetch exclusions.
  while IFS= read -r fetch_spec; do
    # Git's negative refspec can contain a wildcard, so match it as a pattern.
    # shellcheck disable=SC2053
    if [[ "$fetch_spec" == ^* && "$upstream_source" == ${fetch_spec#^} ]]; then
      ff_state="skipped-excluded-upstream"; return 1
    fi
  done <<< "$fetch_specs"

  git -C "$checkout_path" fetch --prune --tags origin >/dev/null || die 'origin fetch failed' 4
  update_state="fetched"
  upstream_oid="$(git -C "$checkout_path" rev-parse --verify '@{upstream}^{commit}')" || {
    ff_state="skipped-missing-upstream"; return 1;
  }
  head_oid="$(git -C "$checkout_path" rev-parse --verify HEAD)" || die 'cannot read cached revision' 3
  if [[ "$head_oid" == "$upstream_oid" ]]; then
    ff_state="up-to-date"
  elif git -C "$checkout_path" merge-base --is-ancestor "$head_oid" "$upstream_oid"; then
    if git -C "$checkout_path" merge --ff-only "$upstream_oid" >/dev/null; then
      ff_state="fast-forwarded"
    else
      ff_state="skipped-merge-failed"; return 1
    fi
  else
    # --ff-only alone also succeeds for a locally ahead branch. Such a checkout
    # does not match the remote source and must not satisfy --force-update.
    ff_state="skipped-non-ff"; return 1
  fi
  [[ "$(git -C "$checkout_path" rev-parse HEAD)" == "$upstream_oid" ]] || {
    ff_state="skipped-revision-changed"; return 1;
  }
  printf '%s\n' "$now_epoch" > "$last_fetch_file"
}

if (( needs_update )); then
  if ! refresh_checkout; then
    if (( force_update )); then
      die "forced update could not complete: $ff_state; cached working tree was not reset" 4
    fi
    printf 'warning: using cached revision; refresh could not complete: %s\n' "$ff_state" >&2
  fi
fi

if (( path_only )); then
  printf '%s\n' "$checkout_path"
else
  cat <<EOF
repo: $host/$repo_path
path: $checkout_path
state: $clone_state
update: $update_state
fast_forward: $ff_state
EOF
fi
