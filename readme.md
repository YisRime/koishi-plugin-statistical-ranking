# koishi-plugin-statistical-ranking

[![npm](https://img.shields.io/npm/v/koishi-plugin-statistical-ranking?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-statistical-ranking)

统计群组内的命令使用和成员发言数据,支持黑白名单过滤,支持按用户/群组/平台筛选展示

## 功能

- 自动统计群组内的命令使用和成员发言数据
- 支持按用户、群组、平台筛选统计数据
- 支持黑名单和白名单过滤
- 支持导入历史数据（需要开启配置）
- 支持清除统计数据（需要管理员权限）
- 支持查看统计对象列表

## 配置项

- `enableImport`: 是否启用数据导入功能（默认关闭）
- `enableClear`: 是否启用数据清除功能（默认关闭）
- `enableBlacklist`: 是否启用黑名单功能（默认关闭）
- `enableWhitelist`: 是否启用白名单功能（默认关闭）
- `blacklist`: 黑名单列表（格式：platform:group:user）
- `whitelist`: 白名单列表（格式：platform:group:user）

## 命令

### stat

查看命令使用统计

- `-u [用户]` 指定用户统计
- `-g [群组]` 指定群组统计
- `-p [平台]` 指定平台统计
- `-c [命令]` 指定命令统计

### stat.user

查看成员发言统计

- `-u [用户]` 指定用户统计
- `-g [群组]` 指定群组统计
- `-p [平台]` 指定平台统计

### stat.list

查看统计列表,包括平台、用户、群组和命令列表

### stat.clear

清除统计数据（需要管理员权限且enableClear=true）

- `-t <类型>` 指定清除类型(command/message)
- `-u [用户]` 指定用户
- `-g [群组]` 指定群组
- `-p [平台]` 指定平台
- `-c [命令]` 指定命令

### stat.import

导入历史统计数据（需要enableImport=true）

- `-f` 覆盖现有数据
