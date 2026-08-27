#!/usr/bin/env node
import { runCli } from './run.js';

// 唯一的退出码落点（GAP-06：业务代码不碰 process.exit）
process.exitCode = await runCli(process.argv);
