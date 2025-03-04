# koishi-plugin-statistical-ranking

[![npm](https://img.shields.io/npm/v/koishi-plugin-statistical-ranking?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-statistical-ranking)

统计成员发言和命令使用并可排行展示

## 功能

- 自动统计群组内的命令使用和成员发言数据
- 支持按用户、群组、平台筛选统计数据
- 支持导入历史数据（需要开启配置）
- 支持清除统计数据（需要管理员权限）

## 配置项

- `enableLegacyImport`: 是否启用历史数据导入功能（默认关闭）

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

### stat.clear

清除统计数据（需要管理员权限）

- `-t <类型>` 指定清除类型
- `-u [用户]` 指定用户
- `-g [群组]` 指定群组
- `-p [平台]` 指定平台
- `-c [命令]` 指定命令

### stat.import

导入历史统计数据（需要开启 enableLegacyImport）

- `-f` 覆盖现有数据
