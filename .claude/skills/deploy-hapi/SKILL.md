---
name: deploy-hapi
description: 构建并部署 HAPI 到生产环境。支持部署 hub、web、cli 的任意组合。自动递增版本号。Use when the user asks to "部署", "deploy", "发版", "上线", or wants to deploy HAPI changes.
argument-hint: [hub|web|cli|all]
---

# Deploy HAPI

构建并部署 HAPI 组件到生产环境。

## 部署路径（重要！不要搞错）

| 组件 | 本地构建输出 | 远程目标路径 |
|------|-------------|-------------|
| Hub | `hub/dist/index.js` | `ubuntu@hapi.1to10.cn:~/hapi-custom/index.js` |
| Web | `web/dist/` | `ubuntu@hapi.1to10.cn:~/hapi-custom/web/dist/` |
| CLI | `cli/dist-exe/bun-darwin-arm64/hapi` | `/opt/homebrew/lib/node_modules/@twsxtd/hapi/node_modules/@twsxtd/hapi-darwin-arm64/bin/hapi` |

**注意**: Web 路径是 `web/dist/`，不是 `web-dist/`！

## Workflow

1. **解析参数** - `$ARGUMENTS` 可以是：
   - `hub` / `web` / `cli` - 只部署指定组件
   - `all` 或空 - 部署所有组件
   - 多个组件用空格分隔：`hub web`

2. **递增版本号**
   - 读取 `web/build-number.json`，将 `build` 加 1
   - 写回文件

3. **构建**
   ```bash
   # Hub
   cd /Users/luxiang/workspace/hapi && bun run build:hub

   # Web
   cd /Users/luxiang/workspace/hapi && bun run build:web

   # CLI
   cd /Users/luxiang/workspace/hapi/cli && bun run build:exe
   ```

4. **部署**
   ```bash
   # Hub - scp 单文件
   scp hub/dist/index.js ubuntu@hapi.1to10.cn:~/hapi-custom/index.js

   # Web - rsync 整个目录
   rsync -az --delete web/dist/ ubuntu@hapi.1to10.cn:~/hapi-custom/web/dist/

   # CLI - 本地替换 + 签名
   cp cli/dist-exe/bun-darwin-arm64/hapi /opt/homebrew/lib/node_modules/@twsxtd/hapi/node_modules/@twsxtd/hapi-darwin-arm64/bin/hapi
   codesign -s - -f /opt/homebrew/lib/node_modules/@twsxtd/hapi/node_modules/@twsxtd/hapi-darwin-arm64/bin/hapi
   ```

5. **重启服务**
   ```bash
   # 如果部署了 Hub 或 Web，重启 PM2
   ssh ubuntu@hapi.1to10.cn "pm2 restart hapi-hub"

   # 如果部署了 CLI，杀旧 session 进程让 runner 用新 binary 重启
   ps aux | grep 'hapi.*claude' | grep -v grep | awk '{print $2}' | xargs kill
   ```

6. **报告结果**
   - 显示新版本号（从 `cli/package.json` 的 version + build number）
   - 确认每个组件的部署状态
   - 提示用户刷新页面/清缓存

## Zhengshu 命名空间

如果用户提到 zhengshu：
- Runner plist: `~/Library/LaunchAgents/com.hapi.runner.zhengshu.plist`
- Token: `fish2026abc:zhengshu`
- HAPI_HOME: `~/.hapi-zhengshu`

## 注意事项

- 部署前不需要 git commit，但部署后可以提醒用户是否要提交
- CLI binary 替换后 macOS 需要 codesign，否则会被 SIGKILL
- 旧 session 进程不会自动使用新 binary，需要 kill 后让 runner 重新拉起
