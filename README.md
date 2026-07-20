# Recall

一个很轻的 Chrome 插件：在网页上看到资料时，一键保存到飞书多维表格，带网页截图、核心内容、发财贴纸动效和飞书日历回看提醒。

## 架构

- `extension/`：Chrome Manifest V3 插件。
- `server/`：本机 Node 服务，负责调用已登录的 `lark-cli` 或飞书 OpenAPI 写入 Base。

Chrome 插件不会保存飞书密钥。资料主记录写入飞书 Base；插件本地只保存配置、待提醒闹钟和失败重试队列。

## 飞书 Base 字段

建议在飞书多维表格建一张表，包含这些字段：

| 字段名 | 类型建议 |
| --- | --- |
| 标题 | 文本 |
| 网页截图 | 附件 |
| 核心内容 | 文本 |
| 链接 | URL 或文本 |
| 来源 | 文本 |
| 标签 | 多选或文本 |
| 重要度 | 单选或文本 |
| 状态 | 单选或文本 |
| 提醒时间 | 日期 |
| 保存时间 | 日期 |
| 日历事件ID | 文本 |

如果你的字段名不同，改 `.env` 里的 `FIELD_*` 映射。

默认会把 `提醒时间`、`保存时间` 按飞书日期字段常用的毫秒时间戳写入。如果你把这两个字段建成了普通文本，把 `.env` 里的 `DATES_AS_TEXT` 改成 `true`。

## 启动本机写入服务

```bash
cd /Users/dongdong/Documents/AI探索/feishu-capture-extension
cp .env.example .env
```

编辑 `.env`，推荐先用本机 `lark-cli` 模式：

- `LARK_WRITE_MODE=lark-cli`
- `LARK_APP_TOKEN`
- `LARK_TABLE_ID`

如果以后要脱离 `lark-cli` 直接走 OpenAPI，再改成：

- `LARK_WRITE_MODE=api`
- `LARK_APP_ID`
- `LARK_APP_SECRET`
- `LARK_APP_TOKEN`
- `LARK_TABLE_ID`

然后运行：

```bash
npm run server
```

健康检查：

```bash
curl http://127.0.0.1:8787/health
```

## 安装 Chrome 插件

1. 打开 `chrome://extensions`
2. 开启开发者模式
3. 点击“加载已解压的扩展程序”
4. 选择：

```text
/Users/dongdong/Documents/AI探索/feishu-capture-extension/extension
```

首次点击插件图标，进入设置页，把 API 地址设为：

```text
http://127.0.0.1:8787
```

## 使用

- 点击插件图标：立即收藏当前网页，并显示发财贴纸动效。
- 右键页面或选中文本：选择“保存到 Recall”。
- 默认会按 `提醒时间` 创建飞书日历回看提醒。
- 同一提醒时间的多条资料会聚合到一个日历事件，例如 `回看：13 条发财资料`。
- 日历事件里的每条资料都有阅读入口；点进去后会把该条表格状态改成 `已读`。
- helper 会定期同步表格里的提醒时间和已读状态。

## 第一版边界

- 不做云同步，飞书 Base 是唯一主表。
- 不把飞书密钥放进 Chrome 插件。
- helper 需要保持运行，点击插件时才能写入飞书表格并同步日历提醒。
