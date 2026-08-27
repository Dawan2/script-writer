# OpenClaw 批量任务 API

远端 OpenClaw 通过 HTTPS API 创建工作台批量任务，不需要安装 MCP 服务，也不需要保存长期授权令牌。

## 安全要求

- 外部访问必须使用 HTTPS。密码的传输加密由 TLS 提供；不要自行对密码做可逆加密，也不要把密码拼入 URL、任务参数或日志。
- 每次请求均使用 HTTP Basic 认证传入工作台账号和密码。服务端只在当前请求中校验密码，不保存或返回密码。
- 认证通过后，服务端重新校验该账号的“批量任务”权限及所选场景权限。任务创建者、后续执行身份和积分消耗均归属于该账号。
- 本机 `127.0.0.1` 调试可以使用 HTTP；对外部署请在 TLS 反向代理后运行，并确保应用收到的请求协议为 `https`。

## 读取可用参数

```bash
curl --fail --user "$WORKBENCH_USERNAME:$WORKBENCH_PASSWORD" \
  https://workbench.example.com/openclaw/v1/batch-tasks/options
```

返回值包含当前账号可用的场景、目标地区、可选停止阶段、分级选项和文件限制。创建前应先读取一次，使用返回的 key 组装请求。

## 创建批量任务

```bash
curl --fail --user "$WORKBENCH_USERNAME:$WORKBENCH_PASSWORD" \
  -H "Idempotency-Key: openclaw-20260806-001" \
  -F 'batch_name=海外改编批次' \
  -F 'tasks=[
    {
      "project_name":"样稿一",
      "scenario":"rewrite",
      "stop_after_stage":"full_generate",
      "target_region":"北美",
      "extra_requirements":"保留悬念节奏",
      "source_file_key":"source_file_0"
    }
  ]' \
  -F 'source_file_0=@/path/to/source.md;type=text/markdown' \
  https://workbench.example.com/openclaw/v1/batch-tasks
```

接口使用 `multipart/form-data`。每条任务通过 `source_file_key` 引用同一请求中的文件字段，支持的文件格式和最大大小以参数接口返回的 `constraints` 为准。

`Idempotency-Key` 必填，长度为 8 至 128 位，仅可包含英文、数字、`.`、`_`、`:`、`-`。同一账号以相同 key 重试相同请求时会返回首次创建结果；若请求内容不同则返回冲突，避免网络重试重复创建任务。
