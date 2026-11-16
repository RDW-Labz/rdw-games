#!/bin/sh
# One-shot git credential helper for the tailnet Gitea: answers username/password from
# ~/.config/gitea/admin ('key: value' lines), which git cannot source as a script.
f="$HOME/.config/gitea/admin"
case "$1" in
  get)
    printf 'username=%s\n' "$(sed -n 's/^username:[[:space:]]*//p' "$f")"
    printf 'password=%s\n' "$(sed -n 's/^password:[[:space:]]*//p' "$f")"
    ;;
esac
