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

查看个人统计信息

- `-v, --visual` 切换可视化模式（反转默认图片模式设置）
- `-s, --sort [count|time|key]` 指定排序方式（默认按次数排序）
- `-u, --user [用户ID]` 指定查看某用户的统计信息（需要权限等级2）

### stat.command [页码|all]

查看命令统计

- `-u, --user [用户]` 指定用户统计
- `-g, --guild [群组]` 指定群组统计
- `-p, --platform [平台]` 指定平台统计
- `-v, --visual` 切换可视化模式
- `-s, --sort [count|time|key]` 指定排序方式

### stat.user [页码|all]

查看发言统计

- `-g, --guild [群组]` 指定群组统计
- `-p, --platform [平台]` 指定平台统计
- `-v, --visual` 切换可视化模式
- `-s, --sort [count|time|key]` 指定排序方式

### stat.guild [页码|all]

查看群组统计数据

- `-u, --user [用户]` 指定用户统计
- `-p, --platform [平台]` 指定平台统计
- `-c, --command [命令]` 指定命令统计
- `-v, --visual` 切换可视化模式
- `-s, --sort [count|time|key]` 指定排序方式

### stat.rank [页码|all]

查看发言排行榜（需启用排行榜功能）

- `-g, --guild [群组]` 指定群组排行（需要权限2）
- `-p, --platform [平台]` 指定平台排行（需要权限2）
- `-t, --time [时间范围]` 指定时间范围（如 `1h`、`d`、`7d`、`30d`，默认`d`为昨日）
- `-v, --visual` 切换可视化模式
- `-a, --all` 显示全局排行

排行榜支持展示成员在指定时间段内的发言增量、当前排名、排名变化等信息。支持图片和文本两种模式。

### stat.list

查看统计列表（需要权限等级3）

- `-u, --user` 显示用户列表
- `-g, --guild` 显示群组列表

不带参数时默认显示平台列表和命令列表。

### stat.clear

清除统计数据（需要权限等级4且enableClear=true）

- `-u, --user [用户]` 指定用户
- `-g, --guild [群组]` 指定群组
- `-p, --platform [平台]` 指定平台
- `-c, --command [命令]` 指定命令
- `-b, --below [次数]` 删除少于指定次数的记录

可以组合使用，例如 `stat.clear -u 123456 -b 5` 会删除用户123456的所有少于5次的记录。

### stat.export

导出统计数据（需要权限等级4且enableDataTransfer=true）

- `-u, --user [用户]` 指定用户
- `-p, --platform [平台]` 指定平台
- `-g, --guild [群组]` 指定群组
- `-c, --command [命令]` 指定命令

### stat.import [序号]

导入统计数据（需要权限等级4且enableDataTransfer=true）

- `-f, --force` 覆盖现有数据
- `-d, --database` 从历史数据库导入

不带序号参数时会显示可导入的文件列表。
