#!/bin/sh
set -eu

usage() {
  echo "usage: snapshot.sh take | diff <snapshot> [git diff options and paths] | restore <snapshot>" >&2
  exit 2
}

cd "$(git rev-parse --show-toplevel)"
repo_objects=$(git rev-parse --path-format=absolute --git-path objects)
repo_index=$(git rev-parse --path-format=absolute --git-path index)

stage_worktree() {
  if [ -f "$repo_index" ]; then
    cp "$repo_index" "$1/index"
  fi
  export GIT_OBJECT_DIRECTORY="$1/objects"
  export GIT_ALTERNATE_OBJECT_DIRECTORIES="$repo_objects"
  export GIT_INDEX_FILE="$1/index"
  git add -A
}

snapshot_tree() {
  [ -f "$1/tree" ] || { echo "snapshot.sh: not a snapshot: $1" >&2; exit 2; }
  cat "$1/tree"
}

[ $# -ge 1 ] || usage
command=$1
shift

case $command in
  take)
    [ $# -eq 0 ] || usage
    snapshot=$(mktemp -d "${TMPDIR:-/tmp}/no-comments.XXXXXX")
    mkdir "$snapshot/objects"
    stage_worktree "$snapshot"
    git write-tree >"$snapshot/tree"
    printf '%s\n' "$snapshot"
    ;;
  diff)
    [ $# -ge 1 ] || usage
    snapshot=$1
    shift
    tree=$(snapshot_tree "$snapshot")
    stage_worktree "$snapshot"
    git diff --cached "$tree" "$@"
    ;;
  restore)
    [ $# -eq 1 ] || usage
    tree=$(snapshot_tree "$1")
    stage_worktree "$1"
    git restore --source="$tree" --worktree -- .
    ;;
  *)
    usage
    ;;
esac
