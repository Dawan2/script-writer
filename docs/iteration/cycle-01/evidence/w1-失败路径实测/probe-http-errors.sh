#!/usr/bin/env bash
# 实验一：同一个失败在 FastAPI 与 Next 代理层的呈现差异。
#
# 前置：npm run dev（前后端都起来），并存在一个可登录账号。
# 用法：ACCOUNT=tester PASSWORD=orca-demo bash probe-http-errors.sh
set -u

API=${API:-http://127.0.0.1:8000}
WEB=${WEB:-http://127.0.0.1:3000}
ACCOUNT=${ACCOUNT:-tester}
PASSWORD=${PASSWORD:-orca-demo}
JAR=$(mktemp)

TOKEN=$(curl -s -X POST "$API/auth/login" -H 'content-type: application/json' \
  -d "{\"username\":\"$ACCOUNT\",\"password\":\"$PASSWORD\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
curl -s -c "$JAR" -o /dev/null -X POST "$WEB/api/auth/login" -H 'content-type: application/json' \
  -d "{\"username\":\"$ACCOUNT\",\"password\":\"$PASSWORD\"}"

show() {
  local label=$1; shift
  curl -s "$@" -D /tmp/h -o /tmp/b
  echo "  ${label}：$(head -1 /tmp/h | tr -d '\r')  $(head -c 200 /tmp/b)"
}

echo "===== 1. 后端错误体的形状与语言 ====="
show "无凭据      " "$API/projects"
show "凭据无效    " "$API/projects" -H "authorization: Bearer not-a-real-token"
show "项目不存在  " "$API/projects/999999/files" -H "authorization: Bearer $TOKEN"
show "任务不存在  " "$API/agent/jobs/999999" -H "authorization: Bearer $TOKEN"
show "路径不存在  " "$API/completely/unknown" -H "authorization: Bearer $TOKEN"
show "登录口令错误" -X POST "$API/auth/login" -H 'content-type: application/json' -d '{"username":"x","password":"y"}'
show "按 id 取项目" "$API/projects/1" -H "authorization: Bearer $TOKEN"

echo
echo "===== 2. 校验失败把提交内容原样回显（含口令） ====="
curl -s -X POST "$WEB/api/auth/login" -H 'content-type: application/json' \
  -d '{"password":"super-secret-value"}' | head -c 300
echo
echo "可触发校验失败的接口数量："
curl -s "$API/openapi.json" | python3 -c '
import json,sys
spec=json.load(sys.stdin)
total=sum(len([m for m in ops if m in {"get","post","put","patch","delete"}]) for ops in spec["paths"].values())
has422=sum(1 for ops in spec["paths"].values() for m,op in ops.items()
           if m in {"get","post","put","patch","delete"} and "422" in (op.get("responses") or {}))
print(f"  {has422} / {total}")'

echo
echo "===== 3. 追踪号在代理层丢失 ====="
echo "  后端 x-request-id 命中数：$(curl -s -D - -o /dev/null "$API/projects/999999/files" -H "authorization: Bearer $TOKEN" | grep -ic '^x-request-id')"
echo "  代理 x-request-id 命中数：$(curl -s -D - -o /dev/null -b "$JAR" "$WEB/api/projects/999999/files" | grep -ic '^x-request-id')"

echo
echo "===== 4. 会话过期：页面照常渲染，数据请求全失败 ====="
EXPIRED=$(python3 - "$API" <<'PY'
import base64, hashlib, hmac, json, time
secret = "dev-change-me-before-production"
b64 = lambda d: base64.urlsafe_b64encode(d).decode().rstrip("=")
now = int(time.time())
body = {"sub": "1", "username": "tester", "role": "admin", "ver": 0, "iat": now - 100000, "exp": now - 10}
encoded = b64(json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode())
print(f"{encoded}.{b64(hmac.new(secret.encode(), encoded.encode(), hashlib.sha256).digest())}")
PY
)
echo "  带过期会话打开工作台：HTTP $(curl -s -o /dev/null -w '%{http_code}' -H "cookie: orca_session=$EXPIRED" "$WEB/workspace")"
echo "  同一会话读项目列表：  $(curl -s -H "cookie: orca_session=$EXPIRED" "$WEB/api/projects")"
echo "  完全没有会话打开工作台：HTTP $(curl -s -o /dev/null -w '%{http_code}' "$WEB/workspace")（中间件跳登录）"

echo
echo "===== 5. 后端不可用时代理层的响应 ====="
echo "  停掉 API 后重跑下面两行即可复现："
echo "    curl -s -D - -b <cookie> $WEB/api/projects"
echo "    curl -s -D - -X POST $WEB/api/auth/login -H 'content-type: application/json' -d '{\"username\":\"x\",\"password\":\"y\"}'"

rm -f "$JAR"
