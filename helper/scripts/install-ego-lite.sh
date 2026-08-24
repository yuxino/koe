#!/bin/zsh
set -euo pipefail

if (( $# > 0 )); then
  print "Koe 现在使用固定扩展 ID，不再需要手动填写 ID。"
fi

exec "${0:A:h:h:h}/Install Koe.command"
