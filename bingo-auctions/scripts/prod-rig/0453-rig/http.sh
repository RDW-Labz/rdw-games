# Minimal HTTP POST over bash /dev/tcp (the rig image has no curl).
# usage: bash http.sh <port> <path> <bearer token or -> <json body>
port=$1; path=$2; tok=$3; body=$4
exec 3<>/dev/tcp/127.0.0.1/$port
{
  printf 'POST %s HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nConnection: close\r\n' "$path"
  [ "$tok" != "-" ] && printf 'Authorization: Bearer %s\r\n' "$tok"
  printf 'Content-Length: %s\r\n\r\n%s' "${#body}" "$body"
} >&3
# status line + body only
awk 'NR==1{sub(/\r$/,""); printf "%s  ", $0} /^\r?$/{b=1; next} b{print}' <&3
