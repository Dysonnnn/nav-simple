# nav-py — 导航页 Python + jQuery 版

与 React 版（`/root/tools/nav`，端口 18080）**并存**的轻量实现，监听 **18081**。

- 后端：Python stdlib 单文件 `nav_web.py`，零第三方依赖
- 前端：jQuery 3.7.1（本地 vendor，零 CDN）+ 原生 CSS
- **编辑直接写回 `config.json`**（React 版做不到：它的后台编辑只能存浏览器 localStorage 草稿）
- 自带反馈界面与反馈跟进（参考 device_manage 的反馈模型，JSON 文件存储）

## 运行

```sh
python3 nav_web.py start     # daemon 化启动（默认 127.0.0.1:18081）
python3 nav_web.py status
python3 nav_web.py restart
python3 nav_web.py stop
python3 nav_web.py run       # 前台运行（供 runit/termux-services 托管）
```

生产环境实际由 termux-services 托管：

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
nav_web.py           # 后端（~470 行）
config.json          # 导航数据（编辑即写回）
static/              # index.html + app.css + app.js + vendor/jquery.min.js
runtime/             # pid / 日志 / backups/（config 自动备份，保留 10 份）/ feedback.json
```

## 安全边界

- 默认绑定 **127.0.0.1**：编辑与反馈接口无鉴权，`--bind 0.0.0.0` 会暴露到局域网（启动时警告），暴露前先补鉴权（参见 device_manage issue 019 的模式）
- 写回三保险：`threading.Lock` 串行、`mkstemp`+`os.replace` 原子写、写前自动备份
- XSS：所有用户文本前端 `.text()` 渲染；反馈入库前 `strip_tags`；单色 SVG 走 `sanitizeSvg()` 后才 `innerHTML`

## 与 React 版的差异

| | React 版 (18080) | Python 版 (18081) |
|---|---|---|
| 编辑持久化 | localStorage 草稿，需手动导出覆盖 | **直接写回 config.json** |
| 后台可用性 | 需 `VITE_ADMIN=true` 构建，生产默认只读 | 始终可用 |
| 反馈功能 | 无 | 有（提交 + 跟进） |
| 部署 | 需 npm build | 单文件 + 静态目录，无构建 |
| 功能范围 | 全部一致（搜索/hash/主题/ping/图标/键盘/移动端） |
