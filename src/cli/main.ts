#!/usr/bin/env node
/**
 * CLI 进程入口：退出码的唯一设定点（SPEC-03-EXT）。
 * 用 process.exitCode 而非 process.exit，保证 stdout/stderr 刷完再退出；
 * 业务代码触碰 process.exit / process.exitCode 会被 ESLint 拦截。
 */
import { runCli } from './run.js';

process.exitCode = await runCli(process.argv);
