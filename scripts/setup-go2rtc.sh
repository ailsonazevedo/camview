#!/usr/bin/env bash
# Baixa o binário do go2rtc para bin/ e cria data/go2rtc.yaml se ainda não existir.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${GO2RTC_VERSION:-v1.9.14}"

case "$(uname -s)" in
  Darwin) os=mac ;;
  Linux) os=linux ;;
  *) echo "Sistema não suportado: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=amd64 ;;
  *) echo "Arquitetura não suportada: $(uname -m)" >&2; exit 1 ;;
esac

mkdir -p bin data

if [ -x bin/go2rtc ] && bin/go2rtc -version 2>/dev/null | grep -q "${VERSION#v}"; then
  echo "go2rtc ${VERSION} já instalado."
else
  echo "Baixando go2rtc ${VERSION} (${os}_${arch})..."
  tmp="$(mktemp -d)"
  if [ "$os" = mac ]; then
    curl -fsSL -o "$tmp/go2rtc.zip" "https://github.com/AlexxIT/go2rtc/releases/download/${VERSION}/go2rtc_mac_${arch}.zip"
    unzip -o -q "$tmp/go2rtc.zip" -d "$tmp"
    mv "$tmp/go2rtc" bin/go2rtc
    xattr -d com.apple.quarantine bin/go2rtc 2>/dev/null || true
  else
    curl -fsSL -o bin/go2rtc "https://github.com/AlexxIT/go2rtc/releases/download/${VERSION}/go2rtc_linux_${arch}"
  fi
  chmod +x bin/go2rtc
  rm -rf "$tmp"
fi

if [ ! -f data/go2rtc.yaml ]; then
  cp go2rtc.template.yaml data/go2rtc.yaml
  echo "Criado data/go2rtc.yaml"
fi
