#!/bin/sh
# Installs or upgrades yok: the binary for this machine, then the agent plugin at its version.
#   curl -fsSL https://raw.githubusercontent.com/vertexcover-io/harness-engineering/v2/install.sh | sh
# YOK_VERSION=vX.Y.Z picks a release; YOK_AGENTS="claude" limits the plugin install.
set -eu

REPO="vertexcover-io/harness-engineering"
BIN_DIR="$HOME/.yok/bin"

say() { printf '%s\n' "$*"; }
die() { printf 'yok install: %s\n' "$*" >&2; exit 1; }

asset_name() {
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) die "no yok build for $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) die "no yok build for $(uname -m)" ;;
  esac
  printf 'yok-%s-%s' "$os" "$arch"
}

release_url() {
  if [ -n "${YOK_RELEASE_URL:-}" ]; then printf '%s' "$YOK_RELEASE_URL"
  elif [ -n "${YOK_VERSION:-}" ]; then printf 'https://github.com/%s/releases/download/%s' "$REPO" "$YOK_VERSION"
  else printf 'https://github.com/%s/releases/latest/download' "$REPO"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

install_binary() {
  asset=$(asset_name)
  base=$(release_url)
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$base/$asset" -o "$tmp/$asset" || die "could not download $asset from $base"
  curl -fsSL "$base/checksums.txt" -o "$tmp/checksums.txt" || die "could not download checksums.txt from $base"
  # awk, not grep: it matches the asset name as a whole field.
  want=$(awk -v a="$asset" '$2 == a { print $1 }' "$tmp/checksums.txt")
  [ -n "$want" ] || die "checksums.txt has no line for $asset; nothing installed"
  [ "$(sha256_of "$tmp/$asset")" = "$want" ] || die "checksum mismatch for $asset; nothing installed"
  mkdir -p "$BIN_DIR"
  chmod 755 "$tmp/$asset"
  mv "$tmp/$asset" "$BIN_DIR/yok"
  say "Installed $BIN_DIR/yok"
}

add_to_path() {
  case "${SHELL:-}" in
    */zsh) rc="$HOME/.zshrc" ;;
    */bash) rc="$HOME/.bashrc" ;;
    *) rc="$HOME/.profile" ;;
  esac
  # Guarded, so a shell that re-reads this file inside an agent session never puts
  # ~/.yok/bin ahead of the session's own yok.
  line='case ":$PATH:" in *":$HOME/.yok/bin:"*) ;; *) export PATH="$HOME/.yok/bin:$PATH" ;; esac'
  if [ -f "$rc" ] && grep -qF "$line" "$rc"; then return 0; fi
  printf '\n%s\n' "$line" >> "$rc"
  say "Added ~/.yok/bin to PATH in $rc. Open a new shell to use yok."
}

check_tools() {
  for tool in git tmux; do
    command -v "$tool" >/dev/null 2>&1 && continue
    case "$(uname -s)" in
      Darwin) say "yok needs $tool to run an agent: brew install $tool" ;;
      *) say "yok needs $tool to run an agent: sudo apt-get install $tool (or your package manager)" ;;
    esac
  done
}

install_plugins() {
  args=""
  for agent in $(printf '%s' "${YOK_AGENTS:-claude codex}" | tr ',' ' '); do
    command -v "$agent" >/dev/null 2>&1 && args="$args --agent $agent"
  done
  if [ -z "$args" ]; then
    say "No claude or codex found. Install the plugin later with: yok plugin install --agent claude"
    return 0
  fi
  # shellcheck disable=SC2086 # args is a list of flags
  "$BIN_DIR/yok" plugin install $args
}

install_binary
add_to_path
check_tools
install_plugins
say "yok $("$BIN_DIR/yok" --version) is ready. Run yok doctor inside a project."
