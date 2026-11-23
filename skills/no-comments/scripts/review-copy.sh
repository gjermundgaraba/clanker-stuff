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

stage_copy() {
  cd "$copy"
  GIT_INDEX_FILE="$copy/.git/no-comments-index" git add -A
}

enter_checkout() {
  cd "$1"
  repo_objects=$(git rev-parse --path-format=absolute --git-path objects)
  repo_index=$(git rev-parse --path-format=absolute --git-path index)
}

tree_commit() {
  GIT_AUTHOR_NAME=no-comments GIT_AUTHOR_EMAIL=no-comments@invalid \
    GIT_COMMITTER_NAME=no-comments GIT_COMMITTER_EMAIL=no-comments@invalid \
    git commit-tree -m no-comments "$@"
}

checkout_trees() {
  rm -f "$1"
  if [ -f "$repo_index" ]; then
    cp "$repo_index" "$1"
  fi
  (
    export GIT_OBJECT_DIRECTORY="$copy/.git/objects"
    export GIT_ALTERNATE_OBJECT_DIRECTORIES="$repo_objects"
    export GIT_INDEX_FILE="$1"
    if [ -f "$1" ]; then
      git -c core.splitIndex=false update-index --no-split-index
    fi
    git -c core.splitIndex=false write-tree >"$2-staged"
    git -c core.splitIndex=false diff --name-only --diff-filter=A -z >"$2-intent"
    git -c core.splitIndex=false add -A
    git -c core.splitIndex=false write-tree >"$2-worktree"
  )
}

[ $# -ge 1 ] || usage
command=$1
shift

case $command in
  take)
    [ $# -eq 0 ] || usage
    version=$(git version | sed 's/^git version \([0-9]*\)\.\([0-9]*\).*/\1 \2/')
    set -- $version
    if [ "$1" -lt 2 ] || { [ "$1" -eq 2 ] && [ "$2" -lt 43 ]; }; then
      echo "review-copy.sh: needs Git 2.43 or newer, found $(git version)" >&2
      exit 2
    fi
    enter_checkout "$(git rev-parse --show-toplevel)"
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
    git config --get-regexp '^remote\..*\.url$' | while read -r key url; do
      git -C "$copy" config --add "$key" "$url"
    done
    pwd >"$copy/.git/no-comments-origin"

    checkout_trees "$copy/.git/no-comments-index" "$copy/.git/no-comments"
    mv "$copy/.git/no-comments-worktree" "$copy/.git/no-comments-base"

    cd "$copy"
    git read-tree "$(cat .git/no-comments-base)"
    git checkout-index -a
    git read-tree "$(cat .git/no-comments-staged)"
    if [ -s .git/no-comments-intent ]; then
      git add -N --pathspec-from-file=.git/no-comments-intent --pathspec-file-nul
    fi
    trap - EXIT
    printf '%s\n' "$copy"
    ;;
  diff)
    [ $# -ge 1 ] || usage
    open_copy "$1"
    shift
    stage_copy
    GIT_INDEX_FILE="$copy/.git/no-comments-index" git diff --cached "$base" "$@"
    ;;
  apply)
    [ $# -eq 1 ] || usage
    open_copy "$1"
    stage_copy
    reviewed=$(GIT_INDEX_FILE="$copy/.git/no-comments-index" git write-tree)
    [ "$reviewed" != "$base" ] || exit 0

    origin=$(cat "$copy/.git/no-comments-origin")
    enter_checkout "$origin"
    checkout_trees "$copy/.git/no-comments-checkout-index" "$copy/.git/no-comments-checkout"
    current=$(cat "$copy/.git/no-comments-checkout-worktree")

    cd "$copy"
    base_commit=$(tree_commit "$base")
    status=0
    merged=$(git merge-tree --write-tree --name-only --no-messages -X no-renames \
      --merge-base="$base_commit" "$(tree_commit -p "$base_commit" "$current")" \
      "$(tree_commit -p "$base_commit" "$reviewed")") || status=$?
    if [ "$status" -eq 1 ]; then
      echo "review-copy.sh: edits made since take conflict with the review in:" >&2
      printf '%s\n' "$merged" | sed -e 1d -e '/^$/d' | uniq >&2
      exit 1
    fi
    [ "$status" -eq 0 ] || exit "$status"
    git diff --binary --no-renames --no-color --no-ext-diff --src-prefix=a/ --dst-prefix=b/ \
      "$current" "$merged" >.git/no-comments.patch
    if [ -s .git/no-comments.patch ]; then
      cd "$origin"
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
