# koishi-plugin-statistical-ranking

[![npm](https://img.shields.io/npm/v/koishi-plugin-statistical-ranking?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-statistical-ranking)

统计命令使用和成员发言记录，支持分命令/群组/用户统计，支持统计发言排行，支持输出图片

## 功能

- 自动统计群组内的命令使用和成员发言数据
- 支持按用户、群组、平台筛选统计数据
- 支持黑名单和白名单过滤显示内容
- 支持数据导入导出（可配置开关）
- 支持从历史数据库导入
- 支持清除统计数据（需要管理员权限）
- 支持查看统计对象列表
- 支持生成统计数据可视化图表（需安装puppeteer插件）
- 支持多种排序方式（按次数、时间、名称）
- 支持发言排行榜，展示成员发言增量排行及排名变化

## 前置依赖

- 必需：`database` - 提供数据存储功能
- 可选：`puppeteer` - 提供图片生成功能，启用后可以生成可视化统计图表
- 可选：`cron` - 提供定时任务功能，启用排行榜功能需要

## 配置项

- `enableDataTransfer`: 是否启用数据导入导出功能（默认开启）
- `defaultImageMode`: 是否默认使用图片模式展示（默认关闭）
- `silentMode`: 是否启用静默模式，限制插件只在特定群组中响应（默认关闭）
- `allowedGuilds`: 静默模式白名单群组ID列表，只有列表中的群组可以使用统计命令
- `enableRank`: 是否启用排行榜功能（默认关闭）
- `updateInterval`: 排行榜快照更新频率，可选 `hourly`/`6h`/`12h`/`daily`（默认每天）
- `displayWhitelist`: 显示过滤白名单，仅展示匹配的记录（优先级高于黑名单）
  - 例如: ['onebot:12345:67890', '.help']
- `displayBlacklist`: 显示过滤黑名单，不默认展示匹配的记录
  - 例如: ['qq:1234:5678', '.message']

## 命令

### stat [页码|all]

查看个人统计信息，包含命令使用和发言情况的汇总

- `-v, --visual` 切换可视化模式（反转默认图片模式设置）
- `-s, --sort [count|time|key]` 指定排序方式（默认按次数排序）
- `-u, --user [用户ID]` 指定查看某用户的统计信息（需要权限等级2）

### stat.command [页码|all]

查看命令统计，显示命令使用频率和最后使用时间

- `-u, --user [用户]` 指定用户统计
- `-g, --guild [群组]` 指定群组统计
- `-p, --platform [平台]` 指定平台统计
- `-v, --visual` 切换可视化模式
- `-a, --all` 显示全局统计
- `-s, --sort [count|time|key]` 指定排序方式

### stat.user [页码|all]

查看发言统计，显示用户发言频率和最后发言时间

- `-g, --guild [群组]` 指定群组统计
- `-p, --platform [平台]` 指定平台统计
- `-v, --visual` 切换可视化模式
- `-a, --all` 显示全局统计
- `-s, --sort [count|time|key]` 指定排序方式

### stat.guild [页码|all]

查看群组统计数据，显示群组活跃度和最后活跃时间

- `-u, --user [用户]` 指定用户统计
- `-p, --platform [平台]` 指定平台统计
- `-c, --command [命令]` 指定命令统计
- `-v, --visual` 切换可视化模式
- `-s, --sort [count|time|key]` 指定排序方式

### stat.rank [页码|all]

查看发言排行榜（需启用排行榜功能）

- `-g, --guild [群组]` 指定群组排行（需要权限2）
- `-p, --platform [平台]` 指定平台排行（需要权限2）
- `-t, --time [时间范围]` 指定时间范围（格式说明见下方）
- `-e, --endTime [结束时间]` 指定结束时间（同样使用时间范围格式）
- `-v, --visual` 切换可视化模式
- `-a, --all` 显示全局排行

排行榜支持展示成员在指定时间段内的发言增量、当前排名、排名变化等信息。支持图片和文本两种模式。

**时间范围格式**：

- `h` 或 `1h` - 1小时
- `d` 或 `1d` - 1天（默认）
- `w` 或 `1w` - 1周
- `m` 或 `1m` - 1个月（30天）
- `y` 或 `1y` - 1年

### stat.list

查看统计列表（需要权限等级3）

- `-u, --user` 显示用户列表
- `-g, --guild` 显示群组列表

不带参数时默认显示平台列表和命令列表。

### stat.clear

清除统计数据（需要权限等级4）

- `-u, --user [用户]` 指定用户
- `-g, --guild [群组]` 指定群组
- `-p, --platform [平台]` 指定平台
- `-c, --command [命令]` 指定命令
- `-b, --below [次数]` 删除少于指定次数的记录
- `-t, --time [天数]` 删除指定天数之前的记录
- `-r, --rank` 只删除排行数据，保留统计数据
- `-d, --drop` 不重建数据表（危险操作）

可以组合使用，例如 `stat.clear -u 123456 -b 5` 会删除用户123456的所有少于5次的记录。

### stat.export

导出统计数据（需要权限等级4且enableDataTransfer=true）

- `-u, --user [用户]` 指定用户
- `-p, --platform [平台]` 指定平台
- `-g, --guild [群组]` 指定群组
- `-c, --command [命令]` 指定命令

导出的数据会保存到 `data/statistical-ranking` 目录下，文件格式为JSON。

### stat.import [序号]

导入统计数据（需要权限等级4且enableDataTransfer=true）

- `-f, --force` 覆盖现有数据
- `-d, --database` 从历史数据库导入

不带序号参数时会显示可导入的文件列表。可以导入从 `stat.export` 命令导出的数据文件，
也可以导入 `analytics` 插件的历史数据库。

## 图片模式说明

通过配置 `defaultImageMode` 可以设置默认是否使用图片模式。使用图片模式可以：

1. 展示更美观的统计数据表格
2. 显示更多统计信息，包括占比、统计条数等
3. 支持分页显示大量数据
4. 支持排行榜展示当前排名和排名变化

使用图片模式需要安装并启用 `puppeteer` 插件。
