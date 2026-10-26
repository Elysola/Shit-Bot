#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:3000}"
AUTH="${AUTH:-}"

usage() {
  cat <<EOF
用法: $(basename "$0") [选项]

选项:
  -m, --mock              发送模拟推文（不需要真实 URL）
  -u, --url <tweet_url>   真实推文 URL
  -c, --content <text>    自定义推文内容
  -a, --author <name>     自定义作者名
  -t, --target <target>   目标频道: normal/r14/all（默认 all）
  -i, --image             生成 Mock 图片（跳过 x-to-img）
  -h, --help              显示帮助

示例:
  $(basename "$0") -m                      # 发送到所有频道（无图片）
  $(basename "$0") -m -i                   # 发送带 Mock 图片
  $(basename "$0") -m -t r14 -i            # R14 频道 + Mock 图片
  $(basename "$0") -m -c "测试内容" -a "test_user" -i
  $(basename "$0") -u "https://x.com/user/status/123456"
  AUTH=user:password $(basename "$0") -m
  API_URL=http://192.168.1.100:3000 $(basename "$0") -m
EOF
}

MOCK=false
TWEET_URL=""
CONTENT=""
AUTHOR=""
TARGET=""
MOCK_IMAGE=false

while [[ $# -gt 0 ]]; do
  case $1 in
    -m|--mock) MOCK=true; shift ;;
    -u|--url) TWEET_URL="$2"; shift 2 ;;
    -c|--content) CONTENT="$2"; shift 2 ;;
    -a|--author) AUTHOR="$2"; shift 2 ;;
    -t|--target) TARGET="$2"; shift 2 ;;
    -i|--image) MOCK_IMAGE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知选项: $1"; usage; exit 1 ;;
  esac
done

BODY="{}"
if $MOCK; then
  BODY='{"mock":true'
  [[ -n "$CONTENT" ]] && BODY="$BODY,\"content\":\"$CONTENT\""
  [[ -n "$AUTHOR" ]] && BODY="$BODY,\"author\":\"$AUTHOR\""
  [[ -n "$TARGET" ]] && BODY="$BODY,\"target\":\"$TARGET\""
  $MOCK_IMAGE && BODY="$BODY,\"mockImage\":true"
  BODY="$BODY}"
elif [[ -n "$TWEET_URL" ]]; then
  BODY="{\"url\":\"$TWEET_URL\""
  [[ -n "$TARGET" ]] && BODY="$BODY,\"target\":\"$TARGET\""
  BODY="$BODY}"
else
  echo "错误: 需要 -m 或 -u 参数"
  usage
  exit 1
fi

echo "发送请求到 $API_URL/api/debug/test-tweet"
echo "Body: $BODY"

CURL_ARGS=(-s -X POST "$API_URL/api/debug/test-tweet" -H "Content-Type: application/json")
[[ -n "$AUTH" ]] && CURL_ARGS+=(-u "$AUTH")

curl "${CURL_ARGS[@]}" -d "$BODY" | jq .
