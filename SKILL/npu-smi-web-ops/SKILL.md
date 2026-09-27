---
name: npu-smi-web-ops
description: Use when operating, debugging, or extending the npu-smi-web NPU monitoring dashboard — deploying/updating it, troubleshooting missing or incorrect host/model status, or modifying SSH polling, model collection, or timezone handling.
---

# npu-smi-web 运维

## Overview

Node.js 监控面板:每 5s SSH 轮询 NPU 主机采集卡占用,每 30s 独立采集运行模型。部署在 `node:22-alpine` 容器,数据持久化于 `data/`(挂载卷)。

## When to Use

- 模型不显示/模型名为空/容器名显示"宿主"
- 主机断连/解析失败反复出现
- 更新代码后重新部署
- 修改采集逻辑、时区、重试机制

## 模型采集 (server.js parseModels / pollModels)

| 现象 | 原因 | 修复 |
| --- | --- | --- |
| 有进程但无模型 | 新版 sglang 用 `sglang serve`,采集只匹配 `sglang.launch_server` | 匹配 `grep -E "sglang(\\.launch_server\| serve)"`、`pgrep -f "sglang\\.launch_server\|sglang serve"` |
| 模型名为空 | `--model-path` 尾部带 `/`(如 `/home/weights/GLM-5.2-w8a8/`),`split("/").pop()` 得空串 | 先 `mp[1].replace(/\/+$/, "").split("/").pop()` |
| 容器名显示"宿主" | cgroup 有 `/docker/<id>`(docker 默认)与 `docker-<id>`(systemd)两种格式 | `grep -oE "docker[-/][0-9a-f]{12,}" \| head -1 \| cut -c 8-`(不可用 `tr -dc`,会残留 hex 字母) |
| 采集不到容器内进程 | 容器 PID namespace 隔离,宿主 `ps` 不可见 | 该机器当前可能真无服务;用 `docker top <容器>` 二次确认 |

**关键坑**:`pollModels` 用 `status[name] = { ...result, ..., models: status[name].models }` 保留 models 字段,否则 5s 的 `pollAll` 会覆盖清空。

## SSH 轮询与状态

- 断连/解析失败都计入 `consecutive_failures`,达 `RETRY_LIMIT`(默认 5)才置失败,期间保留上次成功状态
- `ok = connected && chips.length > 0`
- 传输统一 UTC ISO(`new Date().toISOString()`,带 Z);前端 `new Date()` 按浏览器时区显示。勿写死时区偏移
- 服务器时钟慢时用 HTTP 响应 `Date` 头校准(NTP 可能未同步)

## 部署 / 更新

```bash
docker build --build-arg TARGETPLATFORM=linux/arm64 -t npu-smi-web:latest .
docker rm -f npu-smi-web
docker run -d --name npu-smi-web --restart=unless-stopped \
  -p 8000:8000 -v /var/lib/npu-smi-web:/app/data npu-smi-web:latest
```

- 镜像走代理需 `--build-arg http_proxy/https_proxy`;自签名证书 Dockerfile 已 `strict-ssl false`
- 容器内 `/app` 只读;快速改代码用 `docker cp 文件 npu-smi-web:/app/...` + `docker restart npu-smi-web`
- `config.json` 含密码不入库;键值版 npu-smi 用 `/usr/local/bin/npu-monitor.sh`(脚本需装到各主机)
- 端口:宿主 8000 → 容器 8000;API 在 `/api/hosts`

## Common Mistakes

- 忘带 `grep -v grep` → 采集到自身
- 用 `tr -d "docker-/"` 或 `tr -dc "0-9a-f"` 处理容器 ID → 字母被吃或残留,docker 前缀固定 7 字符用 `cut -c 8-`
- 模型进程瞬时性:共享环境模型随跑随停,单次采样为空不代表逻辑坏,看 HBM 占用佐证
