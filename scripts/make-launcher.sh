#!/bin/sh
# Запуск из исходников под именем процесса «AmneziaWG Client» (симлинк на бинарник Electron)
set -e
cd "$(dirname "$0")/.."
E=$(readlink -f node_modules/electron/dist/electron)
mkdir -p bin && ln -sf "$E" bin/AmneziaWG-Client
