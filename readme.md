# koishi-plugin-statistical-ranking

[![npm](https://img.shields.io/npm/v/koishi-plugin-statistical-ranking?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-statistical-ranking)

统计群组内的命令使用和成员发言数据，支持按用户/群组/平台筛选展示

## 功能

- 自动统计群组内的命令使用和成员发言数据
- 支持按用户、群组、平台筛选统计数据
- 支持黑名单和白名单过滤
- 支持数据导入导出（需要开启配置）
- 支持从历史数据库导入
- 支持清除统计数据（需要管理员权限）
- 支持查看统计对象列表
- 支持图像渲染输出（需安装puppeteer）

## 配置项

- `enableDataTransfer`: 是否启用数据导入导出功能（默认开启）
- `enableClear`: 是否启用数据清除功能（默认开启）
- `enableDisplayFilter`: 是否启用显示过滤功能（默认关闭）
  - 当启用时，可以配置 `displayBlacklist` 和 `displayWhitelist`
  - `displayBlacklist`: 显示过滤黑名单（格式：platform:group:user 或命令名）
    - 例如: ['onebot:12345:67890', 'qq::12345', 'sandbox::', '.help']
  - `displayWhitelist`: 显示过滤白名单（格式同上，优先于黑名单生效）
- `enableImageRender`: 是否启用图片渲染（默认关闭，需安装puppeteer）
  - `renderer`: 图像渲染配置
    - `theme`: 主题，支持 'light' 或 'dark'（默认 'light'）
    - `showAvatar`: 是否显示用户头像（默认开启）
    - `width`: 图像宽度，单位像素（默认 800）
    - `timeout`: 渲染超时时间，单位毫秒（默认 10000）

## 命令

### stat [页码|all]

查看个人统计信息

查看当前用户的命令使用和消息统计情况。

### stat.command [页码|all]

查看命令统计

- `-u, --user [用户]` 指定用户统计
- `-g, --guild [群组]` 指定群组统计
- `-p, --platform [平台]` 指定平台统计
- `-n, --negate` 切换输出模式（文本/图片）

### stat.user [页码|all]

查看发言统计

- `-g, --guild [群组]` 指定群组统计
- `-p, --platform [平台]` 指定平台统计
- `-n, --negate` 切换输出模式（文本/图片）

### stat.guild [页码|all]

查看群组统计数据

- `-u, --user [用户]` 指定用户统计
- `-p, --platform [平台]` 指定平台统计
- `-c, --command [命令]` 指定命令统计
- `-n, --negate` 切换输出模式（文本/图片）

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
