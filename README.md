# nav-py — 轻量导航页（Python + jQuery 版）

零第三方依赖、无构建步骤的单文件后端个人导航页。任何装有 Python 3.8+ 的系统均可直接运行。

- 后端：Python stdlib 单文件 `nav_web.py`，零第三方依赖
- 前端：jQuery 3.7.1（本地 vendor，零 CDN）+ 原生 CSS
- **编辑直接写回 `config.json`**（React 版做不到：它的后台编辑只能存浏览器 localStorage 草稿）
- 自带反馈界面与反馈跟进（JSON 文件存储）

同系列的 React 版本：**[Dysonnnn/nav](https://github.com/Dysonnnn/nav)**（端口 18080）。两版功能对齐（搜索/hash 路由/主题/ping/图标/键盘/移动端），按部署环境任选其一。

## 特性

- **全平台兼容**：Linux / macOS / Windows / Android (Termux)，只要有 Python 3.8+ 即可运行，无平台专属依赖
- **零构建**：单文件后端 + 静态目录，克隆即用
- **数据即文件**：导航数据与反馈都是 JSON 文件，方便备份与迁移

## 快速开始（全平台通用）

```sh
git clone https://github.com/Dysonnnn/nav-simple.git
cd nav-simple
python3 nav_web.py run
```

打开 `http://127.0.0.1:18081` 即可使用。所有平台行为一致，无需额外配置。

## 部署

### 通用：前台 / daemon 模式

```sh
python3 nav_web.py run       # 前台运行；Ctrl+C 停止
python3 nav_web.py start     # daemon 化启动（默认 127.0.0.1:18081）
python3 nav_web.py status
python3 nav_web.py restart
python3 nav_web.py stop
```

daemon 模式通过 pid 文件（`runtime/nav-py.pid`）管理，日志在 `runtime/nav-py.log`。

### Linux 服务器：systemd（可选）

适合作为常驻服务托管，新建 `~/.config/systemd/user/nav-py.service`：

```ini
[Unit]
Description=nav-py navigation page
After=network.target

[Service]
WorkingDirectory=%h/tools/nav-py
ExecStart=/usr/bin/python3 %h/tools/nav-py/nav_web.py run
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now nav-py
```

### Termux / Android：runit（termux-services）

生产环境由 runit 托管：

```sh
sv=/data/data/com.termux/files/usr/bin/sv
$sv status /data/data/com.termux/files/usr/var/service/nav-py
```

开机启动走 `~/.termux/boot/start-nav-py.sh`（Termux:Boot）。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 主页 |
| GET | `/api/config` | 完整配置（no-store） |
| PUT | `/api/config` | 全量保存：校验 → 备份 → 原子写 |
| GET | `/api/feedback?status=open\|resolved\|all` | 反馈列表 + 计数 |
| POST | `/api/feedback` | 提交反馈（strip_tags 净化） |
| PATCH | `/api/feedback/{id}` | 回复 / 标记解决 / 重新打开 |

## 文件

```
nav_web.py           # 后端（~480 行）
config.json          # 导航数据（编辑即写回）
static/              # index.html + app.css + app.js + vendor/jquery.min.js
runtime/             # pid / 日志 / backups/（config 自动备份，保留 10 份）/ feedback.json
```

## 安全边界

- 默认绑定 **127.0.0.1**：编辑与反馈接口无鉴权，`--bind 0.0.0.0` 会暴露到局域网（启动时警告），暴露前先补鉴权
- 写回三保险：`threading.Lock` 串行、`mkstemp`+`os.replace` 原子写、写前自动备份
- XSS：所有用户文本前端 `.text()` 渲染；反馈入库前 `strip_tags`；单色 SVG 走 `sanitizeSvg()` 后才 `innerHTML`

## 与 React 版的差异

React 版仓库：[Dysonnnn/nav](https://github.com/Dysonnnn/nav)

| | React 版 (18080) | Python 版 (18081) |
|---|---|---|
| 编辑持久化 | localStorage 草稿，需手动导出覆盖 | **直接写回 config.json** |
| 后台可用性 | 需 `VITE_ADMIN=true` 构建，生产默认只读 | 始终可用 |
| 反馈功能 | 无 | 有（提交 + 跟进） |
| 部署 | 需 npm build | 单文件 + 静态目录，无构建 |
| 功能范围 | 全部一致（搜索/hash/主题/ping/图标/键盘/移动端） |
