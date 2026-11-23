#!/bin/sh
set -eu

usage() {
  echo "usage: review-copy.sh take | diff <copy> [git diff options and paths] | apply <copy> | drop <copy>" >&2
  exit 2
}

open_copy() {
  [ -f "$1/.git/no-comments-base" ] || { echo "review-copy.sh: not a review copy: $1" >&2; exit 2; }
  copy=$(cd "$1" && pwd)
  base=$(cat "$copy/.git/no-comments-base")
}

copy_diff() {
  cd "$copy"
  GIT_INDEX_FILE="$copy/.git/no-comments-index" git add -A
  GIT_INDEX_FILE="$copy/.git/no-comments-index" git diff --cached "$base" "$@"
}

[ $# -ge 1 ] || usage
command=$1
shift

case $command in
  take)
    [ $# -eq 0 ] || usage
    cd "$(git rev-parse --show-toplevel)"
    repo_objects=$(git rev-parse --path-format=absolute --git-path objects)
    repo_index=$(git rev-parse --path-format=absolute --git-path index)
    repo_shallow=$(git rev-parse --path-format=absolute --git-path shallow)
    copy=$(mktemp -d "${TMPDIR:-/tmp}/no-comments.XXXXXX")
    trap 'rm -rf "$copy"' EXIT
    git init -q "$copy"
    printf '%s\n' "$repo_objects" >"$copy/.git/objects/info/alternates"
    if [ -f "$repo_shallow" ]; then
      cp "$repo_shallow" "$copy/.git/shallow"
    fi
    git for-each-ref --format='update %(refname) %(objectname)' refs/heads refs/remotes refs/tags |
      git -C "$copy" update-ref --stdin
    if head=$(git rev-parse -q --verify HEAD); then
      git -C "$copy" update-ref --no-deref HEAD "$head"
    fi
    pwd >"$copy/.git/no-comments-origin"

    if [ -f "$repo_index" ]; then
      cp "$repo_index" "$copy/.git/no-comments-index"
    fi
    (
      export GIT_OBJECT_DIRECTORY="$copy/.git/objects"
      export GIT_ALTERNATE_OBJECT_DIRECTORIES="$repo_objects"
      export GIT_INDEX_FILE="$copy/.git/no-comments-index"
      git write-tree >"$copy/.git/no-comments-staged"
      git add -A
      git write-tree >"$copy/.git/no-comments-base"
    )

    cd "$copy"
    git read-tree "$(cat .git/no-comments-base)"
    git checkout-index -a
    git read-tree "$(cat .git/no-comments-staged)"
    trap - EXIT
    printf '%s\n' "$copy"
    ;;
  diff)
    [ $# -ge 1 ] || usage
    open_copy "$1"
    shift
    copy_diff "$@"
    ;;
  apply)
    [ $# -eq 1 ] || usage
    open_copy "$1"
    (copy_diff --binary --full-index --no-renames --no-color --no-ext-diff \
      --src-prefix=a/ --dst-prefix=b/) >"$copy/.git/no-comments.patch"
    if [ -s "$copy/.git/no-comments.patch" ]; then
      cd "$(cat "$copy/.git/no-comments-origin")"
      git apply --whitespace=nowarn "$copy/.git/no-comments.patch"
    fi
    ;;
  drop)
    [ $# -eq 1 ] || usage
    open_copy "$1"
    rm -rf "$copy"
    ;;
  *)
    usage
    ;;
esac
