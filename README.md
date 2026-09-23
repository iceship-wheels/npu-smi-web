# NPU-SMI Monitor

Real-time NPU status dashboard with reservation queue. Polls hosts via SSH every 5s.

- 实时监控各 NPU 宿主机每张卡的 **AI Core 占用率** 与 **HBM 用量**
- 维护未来一周的排队占用清单（按设备分卡片，冲突检测，落盘持久化）
- 每台设备独立公告栏（双击编辑）

## 目录结构

```
npu-smi-web/
├── server.js             # 后端: SSH 轮询 + HTTP API
├── static/               # 前端页面
├── config.example.json   # 配置模板 (复制为 config.json 后填写)
├── scripts/
│   └── npu-monitor.sh    # 键值版 npu-smi 输出转换脚本 (需安装到各 NPU 主机)
├── Dockerfile            # node:22-alpine 镜像
└── data/                 # 运行时持久化 (queue.json / announcements.json, 不入库)
```

## 架构

```
浏览器 ──HTTP:8000──> npu-smi-web 容器 (Node.js)
                          │ SSH:22
                          ▼
              各 NPU 宿主机: /usr/local/bin/npu-monitor.sh
                          │
                          ▼
                  npu-smi (CANN toolkit)
```

监控 web 与 NPU 宿主机之间通过 **SSH** 采集，需要：
- web 所在服务器能 SSH 到每台 NPU 主机（密码或密钥认证）
- NPU 主机上有 `npu-smi` 命令（CANN toolkit）

---

## 部署指导（详细步骤）

以下以 61.47.19.70 部署、监控 61.47.19.71 为例。

### 0. 前置准备

| 项 | 说明 |
| --- | --- |
| 镜像 | 宿主机已有 `node:22-alpine`（或可拉取）。若需代理，见步骤 3 |
| Docker | 宿主机安装 docker，且当前用户有权限（或用 root） |
| 网络 | 监控容器 → NPU 主机 22 端口可达：`timeout 5 bash -c 'cat < /dev/null > /dev/tcp/<host>/22' && echo OPEN` |
| npu-smi 版本 | 先确认输出格式，决定 `command` 配置（见步骤 5） |

### 1. 同步代码

将项目目录完整拷贝到宿主机，例如 `/home/<user>/npu-smi-web`（**必须保留 `scripts/` 与 `static/`**）。

### 2. 准备配置

```bash
cd /home/<user>/npu-smi-web
cp config.example.json config.json
vi config.json
```

`hosts` 每项字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | ✓ | 设备显示名，前端卡片标题 |
| `host` | ✓ | NPU 主机 IP |
| `port` | | SSH 端口，默认 22 |
| `username` | ✓ | SSH 用户，通常 root |
| `password` | 二选一 | 密码认证 |
| `key_path` | 二选一 | 私钥路径（优先于 password），容器内需能读到该路径 |
| `command` | | 采集命令，默认 `npu-smi info -t 5`；键值版 npu-smi 用 `/usr/local/bin/npu-monitor.sh`（见步骤 5） |

> ⚠️ `config.json` 含密码，已在 `.gitignore` 中，**不要提交入库**。

### 3. 构建镜像

```bash
cd /home/<user>/npu-smi-web
docker build --build-arg TARGETPLATFORM=linux/arm64 -t npu-smi-web:latest .
```

- `TARGETPLATFORM` 按宿主机架构填 `linux/arm64`（aarch64）或 `linux/amd64`。不填会报 `invalid argument`。
- 若构建需走代理（npm 拉包），追加：

```bash
docker build \
  --build-arg TARGETPLATFORM=linux/arm64 \
  --build-arg http_proxy="http://user:pass@proxy:port" \
  --build-arg https_proxy="http://user:pass@proxy:port" \
  --build-arg no_proxy="127.0.0.1,*.huawei.com,localhost,local,.local,inhuawei.com" \
  -t npu-smi-web:latest .
```

> 代理是自签名证书时，Dockerfile 已内置 `npm config set strict-ssl false`。
> `apk add python3 make g++` 已从 Dockerfile 移除：express/ssh2 为纯 JS，无需编译；且 apk 经代理下载 APKINDEX 易损坏。
> 构建较慢属正常，耐心等待 `Successfully tagged`。

### 4. 启动容器

```bash
mkdir -p /var/lib/npu-smi-web          # 持久化目录 (排队/公告数据)
docker run -d --name npu-smi-web --restart=unless-stopped \
  -p 8000:8000 \
  -v /var/lib/npu-smi-web:/app/data \
  npu-smi-web:latest
```

- 端口：宿主机 `8000` 映射容器 `8000`。冲突时改 `-p <其他端口>:8000`。
- 数据：`data/` 挂载到宿主机目录，容器删除重建后排队与公告不丢。
- 容器默认以 `node` 用户运行（镜像内 `USER node`），`/app` 内代码只读，改配置需重建镜像或 `docker cp`（`data/` 例外，已挂载）。

**验证**：

```bash
docker ps --filter name=npu-smi-web
curl -s http://localhost:8000/api/hosts    # 应返回 hosts 状态
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8000/   # 200
```

浏览器访问 `http://<宿主机IP>:8000`。

### 5. 配置 npu-smi 采集命令（关键，易错）

不同 npu-smi 版本输出格式不同，web 端解析器只认 `|` 管道表格（表头含 `AICore` 或 `HBM`）。

**先在 NPU 主机上确认格式**：

```bash
npu-smi info -t 5        # ① 旧版表格版: 可用, command 填默认
npu-smi info -t usages -i 0   # ② 键值版 (Ascend910): 输出 "Key : Value", 解析器无法直接识别
```

**② 键值版必须使用转换脚本** `scripts/npu-monitor.sh`，将其安装到每台 NPU 主机：

```bash
# 在任意能 SSH 到 NPU 主机的机器上 (含监控容器)
scp scripts/npu-monitor.sh root@<npu-host>:/usr/local/bin/npu-monitor.sh
ssh root@<npu-host> chmod +x /usr/local/bin/npu-monitor.sh
```

验证脚本输出：

```bash
ssh root@<npu-host> /usr/local/bin/npu-monitor.sh
# 应输出:
# | NPU-ID | AICore(%) | HBM-Usage(MB) |
# | 0 | 0 | 3276 / 65536 |  ...
```

然后在 `config.json` 中将该主机 `command` 设为 `/usr/local/bin/npu-monitor.sh`。

### 6. 更新代码/配置后重新部署

```bash
# 1) 重新同步代码到宿主机
# 2) 重建镜像 (配置改动时 config.json 也需在镜像内, 或用 docker cp 覆盖)
docker build --build-arg TARGETPLATFORM=linux/arm64 -t npu-smi-web:latest .
# 3) 重建容器
docker rm -f npu-smi-web
docker run -d --name npu-smi-web --restart=unless-stopped \
  -p 8000:8000 -v /var/lib/npu-smi-web:/app/data npu-smi-web:latest
```

仅改 `data/`（排队/公告）无需重建，直接生效。

## 日常运维

| 操作 | 命令 |
| --- | --- |
| 查看状态 | `docker ps --filter name=npu-smi-web` |
| 查看日志 | `docker logs -f npu-smi-web` |
| 重启 | `docker restart npu-smi-web` |
| 停止/删除 | `docker rm -f npu-smi-web`（`data/` 已挂载，数据不丢） |
| 备份数据 | `cp -r /var/lib/npu-smi-web /backup/` |

## 排错

| 现象 | 排查 |
| --- | --- |
| `badge` 显示「已断连」 | 检查容器→NPU 主机 22 端口连通；检查用户名/密码；npu-smi 是否在该主机 PATH 中 |
| 显示「解析失败」且 raw 是 `Usage:` 帮助文本 | `npu-smi info -t 5` 不受支持，改用 `npu-monitor.sh`（步骤 5） |
| 显示「解析失败」且 raw 是键值文本 | 同左：确认 command 指向 `/usr/local/bin/npu-monitor.sh` |
| 镜像构建报 `invalid argument` | 补 `--build-arg TARGETPLATFORM=linux/<arch>` |
| 构建时 npm 报 `SELF_SIGNED_CERT_IN_CHAIN` | 代理中间人证书，Dockerfile 已含 `strict-ssl false` |
| 容器启动即退出 | `docker logs npu-smi-web` 看报错；确认 8000 未被占用 |
| 排队数据丢失 | 检查 `-v` 挂载是否正确；`/app/data` 是否可写 |

## config.example.json 说明

详见文件内 `_说明` 字段。认证方式二选一：填 `password` 或 `key_path`。
