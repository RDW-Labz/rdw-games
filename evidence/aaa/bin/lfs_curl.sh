#!/bin/bash
# Fetch LFS pointers under given dirs via gitea batch+download (curl).
cd ~/freegames/work/0ad
for p in $(grep -rl 'version https://git-lfs' "$@" 2>/dev/null); do
  oid=$(grep -o 'sha256:[0-9a-f]*' "$p" | cut -d: -f2)
  sz=$(grep -o 'size [0-9]*' "$p" | cut -d' ' -f2)
  href=$(curl -s --max-time 60 -X POST -H 'Accept: application/vnd.git-lfs+json' -H 'Content-Type: application/vnd.git-lfs+json' \
    -d "{\"operation\":\"download\",\"transfers\":[\"basic\"],\"objects\":[{\"oid\":\"$oid\",\"size\":$sz}]}" \
    https://gitea.wildfiregames.com/0ad/0ad.git/info/lfs/objects/batch | grep -o '"href":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -n "$href" ]; then
    curl -sfL --retry 4 --max-time 300 -o $HOME/freegames/lfsobj$oid "$href" 2>/dev/null && mv /tmp_lfs_$oid "$p" && echo "OK $p $sz"
  else
    echo "NOHREF $p"
  fi
done
