# B-1 / B-2 / B-3　`npm run check` 输出

判定出处：实现规格第 6 节 B 组。

## B-2　校验脚本已接入 `npm run check`，且在当前代码上无误报

```
$ npm run check
2:> orca-script-workbench@0.1.0 check
3:> cd apps/web && tsc --noEmit && cd ../api && .venv/bin/python -m compileall app && .venv/bin/python -m app.scripts.check_error_registry && cd ../../Agents && npm run check
11:错误码注册表校验通过：46 个接口错误码、3 个客户端错误码、78 个创作失败码
退出码：0
```

注册表校验单独执行：

```
$ npm run check:errors

错误码注册表校验通过：46 个接口错误码、3 个客户端错误码、78 个创作失败码
退出码：0
```

## B-1　人为删掉一个 `hint`，脚本非零退出；恢复后通过

人为违规写法（删掉 `error_codes.json` 里 `STAGE_FILE_MISSING` 的 `hint` 字段）：

```
$ npm run check:errors

错误码注册表校验未通过，共 1 项：
  - http_codes.STAGE_FILE_MISSING.hint 为空：面向用户的错误码必须同时给出发生了什么与下一步怎么办
退出码：1
```

恢复后：

```
$ npm run check:errors

错误码注册表校验通过：46 个接口错误码、3 个客户端错误码、78 个创作失败码
退出码：0
```

## B-3　新增裸字符串错误文案会被拦下

人为违规写法一（在 `app/routers/agent.py` 取消任务后加一处中文裸字符串抛错）：

```python
    if job["status"] == "queued":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="这项创作还在排队，暂时不能取消。")
```

```
$ npm run check
错误码注册表校验未通过，共 1 项：
  - apps/api/app/routers/agent.py 新增了 1 处裸字符串错误文案（记账 4 处，现有 5 处）：请改用 error_codes.json 里的错误码
退出码：1
```

人为违规写法二（同一处改成英文裸字符串，英文零容忍、不看记账）：

```python
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Job still queued")
```

```
$ npm run check:errors
错误码注册表校验未通过，共 1 项：
  - apps/api/app/routers/agent.py:366 抛出了英文裸字符串文案：raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Job still queued")
退出码：1
```

恢复后：

```
$ npm run check:errors

错误码注册表校验通过：46 个接口错误码、3 个客户端错误码、78 个创作失败码
退出码：0
```
