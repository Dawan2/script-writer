# 失败路径实测证据

对应文档：[交互可靠性-失败路径实测与契约裂缝](../../交互可靠性-失败路径实测与契约裂缝.md)

## 前置

```bash
npm install
cd apps/api && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
cd ../.. && npm run api:create-user -- --username tester --password orca-demo --display-name 测试员 --role admin
npm run dev
```

## 脚本

| 脚本 | 验证内容 | 记录 |
| --- | --- | --- |
| `probe-http-errors.sh` | 错误体形状与语言、校验失败回显提交内容、追踪号是否透传、会话过期后的页面表现 | `实测记录-http错误.txt` |
| `probe-duplicate-submit.sh` | 同一新建意图并发提交三次是否产生重复项目 | `实测记录-重复提交.txt` |
| `probe-knowledge-status.mjs` | 创作知识库为空时验收门禁是否放行 | `实测记录-知识库为空.txt` |

前两个脚本在仓库根目录执行；第三个需要在 `Agents/` 下执行：

```bash
bash docs/iteration/cycle-01/evidence/w1-失败路径实测/probe-http-errors.sh
bash docs/iteration/cycle-01/evidence/w1-失败路径实测/probe-duplicate-submit.sh
cd Agents && node ../docs/iteration/cycle-01/evidence/w1-失败路径实测/probe-knowledge-status.mjs
```

## 脱敏

记录中不含剧本正文与真实用户数据。实验账号与口令是本地开发账号，脚本中出现的 `super-secret-value` 是为验证回显问题而故意提交的字符串，不是真实口令。

## 后端不可用的复现

`probe-http-errors.sh` 第 5 节只打印复现命令，因为它需要先停掉 API。手动执行：

```bash
# 停掉 npm run dev:api 后
curl -s -D - http://127.0.0.1:3000/api/projects
curl -s -D - -X POST http://127.0.0.1:3000/api/auth/login \
  -H 'content-type: application/json' -d '{"username":"x","password":"y"}'
```

两者都返回 `HTTP 500` 且响应体为空。
