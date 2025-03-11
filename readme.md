# koishi-plugin-statistical-ranking

[![npm](https://img.shields.io/npm/v/koishi-plugin-statistical-ranking?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-statistical-ranking)

统计群组内的命令使用和成员发言数据，支持黑白名单过滤，支持按用户/群组/平台筛选展示

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
- `enableFilter`: 是否启用记录过滤功能（默认关闭）
  - 当启用时，可以配置 `blacklist` 和 `whitelist`
- `blacklist`: 记录黑名单列表（格式：platform:group:user 或命令名）
  - 例如: ['onebot:12345:67890', 'qq::12345', 'sandbox::', '.help']
- `whitelist`: 记录白名单列表（格式同上，优先于黑名单生效）
- `enableDisplayFilter`: 是否启用显示过滤功能（默认关闭）
  - 当启用时，可以配置 `displayBlacklist` 和 `displayWhitelist`
- `displayBlacklist`: 显示过滤黑名单（同记录黑名单格式）
- `displayWhitelist`: 显示过滤白名单（同记录白名单格式）

## 命令

### stat [页码|all]

查看命令使用统计

- `-u, --user [用户]` 指定用户统计
- `-g, --guild [群组]` 指定群组统计
- `-p, --platform [平台]` 指定平台统计
- `-a, --all` 显示所有记录（不过滤）
- `-n, --page [页码]` 指定页码

### stat.user [页码|all]

查看成员发言统计

- `-g, --guild [群组]` 指定群组统计
- `-p, --platform [平台]` 指定平台统计
- `-a, --all` 显示所有记录（不过滤）
- `-n, --page [页码]` 指定页码

### stat.guild [页码|all]

查看群组统计数据

- `-u, --user [用户]` 指定用户统计
- `-p, --platform [平台]` 指定平台统计
- `-c, --command [命令]` 指定命令统计
- `-a, --all` 显示所有记录（不过滤）
- `-n, --page [页码]` 指定页码

### stat.list

查看统计列表（需要管理员权限）

- `-u, --user` 显示用户列表
- `-g, --guild` 显示群组列表

不带参数时默认显示平台列表和命令列表。

### stat.clear

清除统计数据（需要管理员权限且enableClear=true）

- `-u, --user [用户]` 指定用户
- `-g, --guild [群组]` 指定群组
- `-p, --platform [平台]` 指定平台
- `-c, --command [命令]` 指定命令

### stat.import

导入历史统计数据（需要管理员权限且enableImport=true）

- `-f, --force` 覆盖现有数据
