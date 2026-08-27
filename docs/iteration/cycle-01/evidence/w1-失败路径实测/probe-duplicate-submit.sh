#!/usr/bin/env bash
# 实验二：同一个新建意图并发提交三次，验证是否产生重复项目（对应 FM-03）。
#
# 前置：npm run dev:api 已启动，并存在一个可登录账号。
# 用法：ACCOUNT=tester PASSWORD=orca-demo bash probe-duplicate-submit.sh
set -u

API=${API:-http://127.0.0.1:8000}
ACCOUNT=${ACCOUNT:-tester}
PASSWORD=${PASSWORD:-orca-demo}
NAME="重复提交实验-$(date +%s)"
WORK=$(mktemp -d)
printf '# 实验用剧本\n\n第1集\n\n人物：小明\n' > "$WORK/src.md"

TOKEN=$(curl -s -X POST "$API/auth/login" -H 'content-type: application/json' \
  -d "{\"username\":\"$ACCOUNT\",\"password\":\"$PASSWORD\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

for i in 1 2 3; do
  curl -s -X POST "$API/projects" -H "authorization: Bearer $TOKEN" \
    -F "project_name=$NAME" -F 'target_region=北美' -F 'requirements=同一个意图提交三次' \
    -F 'task_type=rewrite' -F "source_file=@$WORK/src.md" \
    -o "$WORK/r$i.json" -w "  第 $i 次提交：HTTP %{http_code}\n" &
done
wait

python3 - "$WORK" "$NAME" <<'PY'
import json, sys
from pathlib import Path
work, name = Path(sys.argv[1]), sys.argv[2]
print("  服务端返回的项目：")
for i in (1, 2, 3):
    project = json.loads((work / f"r{i}.json").read_text()).get("project", {})
    print(f"    id={project.get('id')}  目录={project.get('workspace_dir')}")
PY

curl -s -G "$API/projects" --data-urlencode "query=$NAME" -H "authorization: Bearer $TOKEN" \
  | python3 -c "
import json,sys
name='$NAME'
projects=[p for p in json.load(sys.stdin)['projects'] if p['name']==name]
print(f'  列表中同名项目数：{len(projects)}')"

rm -rf "$WORK"
