# Recall 本地安装指南

这是本地安装版：数据写入使用者自己的飞书多维表格，不经过你的飞书账号，也不需要公共后端。

## 1. 准备飞书表格

在飞书多维表格里建一张表，建议字段如下：

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

如果字段名不一样，后面在 `.env` 里改对应的 `FIELD_*` 即可。

## 2. 配置本机 helper

解压安装包后，进入文件夹，把 `.env.example` 复制一份并命名为 `.env`。

在 `.env` 填自己的飞书表格信息：

```env
LARK_WRITE_MODE=lark-cli
LARK_APP_TOKEN=你的多维表格 app_token
LARK_TABLE_ID=你的 table_id
```

推荐使用已经登录好的 `lark-cli`。如果本机还没有配置飞书 CLI，需要先完成登录和授权。

## 3. 启动 helper

macOS 可以双击：

```text
scripts/start-helper.command
```

也可以在终端运行：

```bash
npm run server
```

看到 `Feishu capture server listening on http://127.0.0.1:8787` 就说明启动成功。

## 4. 安装 Chrome 插件

1. 打开 `chrome://extensions`
2. 开启右上角“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择安装包里的 `extension` 文件夹
5. 右键插件图标，进入“选项”
6. API 地址保持：

```text
http://127.0.0.1:8787
```

资料库地址填自己的飞书多维表格地址。

## 5. 使用方式

打开任意网页后，点击 Chrome 工具栏里的 Recall 图标即可收藏。

成功后页面会出现发财贴纸动效，并把标题、网页截图、核心内容、链接、来源、标签等写入飞书表格。

如果 `.env` 里保持 `CALENDAR_EVENTS_ENABLED=true`，helper 会自动创建飞书日历回看提醒。

- 同一提醒时间的多条资料会合并成一个日程，例如 `回看：13 条发财资料`。
- 日程详情里会列出每条资料的阅读入口。
- 点阅读入口后，会跳转原网页，并把对应表格记录改成 `已读`。
- 如果你在表格里改了提醒时间，helper 会按 `REMINDER_SYNC_INTERVAL_MINUTES` 定期同步。

## 常见问题

- 点插件但表格没有新增：确认 `scripts/start-helper.command` 仍在运行。
- 提示连接失败：确认 API 地址是 `http://127.0.0.1:8787`。
- 截图为空：有些 Chrome 内置页、扩展页或受限页面不允许截图，普通网页一般可以。
- 字段写入失败：确认飞书表格字段名和 `.env` 里的 `FIELD_*` 一致。
- 没有日历提醒：确认 `.env` 里 `CALENDAR_EVENTS_ENABLED=true`，并且表格里有 `日历事件ID` 这一列。
