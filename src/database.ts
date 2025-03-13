import { Context } from 'koishi'
import { Config, StatRecord } from './index'
import { utils } from './utils'
import * as fs from 'fs'
import * as path from 'path'

/**
 * 目标对象接口
 * @interface Target
 * @description 用于权限检查的目标对象结构
 */
interface Target {
  platform: string
  guildId: string
  userId: string
}

/**
 * @internal
 * 数据库操作相关函数集合
 * @description 提供数据库初始化、记录保存、权限检查等核心功能
 */
export const database = {
  /**
   * 初始化数据库表结构
   * @param ctx - Koishi 上下文
   * @description 创建并定义 analytics.stat 表的结构
   */
  initialize(ctx: Context) {
    ctx.model.extend('analytics.stat', {
      id: 'unsigned',
      platform: { type: 'string', length: 60 },
      guildId: { type: 'string', length: 150 },
      userId: { type: 'string', length: 150 },
      command: { type: 'string', length: 150 },
      guildName: { type: 'string', nullable: true },
      userName: { type: 'string', nullable: true },
      count: 'unsigned',
      lastTime: 'timestamp',
    }, {
      primary: 'id',
      autoInc: true,
      unique: [['platform', 'guildId', 'userId', 'command']],
    })
  },

  /**
   * 保存统计记录
   * @param ctx - Koishi 上下文
   * @param data - 需要保存的记录数据
   * @description 检查权限并更新或插入统计记录
   */
  async saveRecord(ctx: Context, data: Partial<StatRecord>) {
    if (!data.platform || !data.guildId || !data.userId) {
      ctx.logger.warn('Invalid record data:', data)
      return
    }

    if (!data.command) {
      data.command = '__message__'
    }

    const target = {
      platform: data.platform,
      guildId: data.guildId,
      userId: data.userId
    }
    const config = ctx.config.statistical_ranking
    if (!(await database.checkPermissions(config, target))) return
    await database.upsertRecord(ctx, data)
  },

  /**
   * 检查操作权限
   * @param config - 插件配置
   * @param target - 目标对象
   * @returns 是否有权限
   */
  async checkPermissions(config: Config, target: Target): Promise<boolean> {
    if (!config?.enableFilter) {
      return true
    }
    // 优先检查白名单
    if (config?.whitelist?.length) {
      return utils.matchRuleList(config.whitelist, target)
    }
    // 白名单为空时，检查黑名单
    if (config?.blacklist?.length) {
      return !utils.matchRuleList(config.blacklist, target)
    }
    return true
  },

  /**
   * 批量更新或插入记录
   * @param ctx - Koishi 上下文
   * @param data - 记录数据
   * @description 使用 upsert 操作保存记录，出错时记录日志
   */
  async upsertRecord(ctx: Context, data: Partial<StatRecord>) {
    try {
      const commandValue = data.command || '__message__'
      const query = {
        platform: data.platform,
        guildId: data.guildId,
        userId: data.userId,
        command: commandValue
      }

      const userName = data.userName !== undefined ? utils.sanitizeString(data.userName) : undefined
      const guildName = data.guildName !== undefined ? utils.sanitizeString(data.guildName) : undefined

      const existing = await ctx.database.get('analytics.stat', query)
      if (existing.length) {
        // 更新现有记录
        const updateData: any = {
          count: existing[0].count + 1,
          lastTime: new Date()
        }

        // 只在有新值时更新用户名和群组名
        if (userName !== undefined) updateData.userName = userName
        if (guildName !== undefined) updateData.guildName = guildName

        await ctx.database.set('analytics.stat', query, updateData)
      } else {
        // 创建新记录
        await ctx.database.create('analytics.stat', {
          ...query,
          userName,
          guildName,
          count: 1,
          lastTime: new Date()
        })
      }
    } catch (e) {
      ctx.logger.error('保存记录失败:', e, data)
    }
  },

  /**
   * 导入历史数据
   * @param ctx Koishi上下文
   * @param overwrite 是否覆盖现有数据
   */
  async importLegacyData(ctx: Context, overwrite = false) {
    if (!ctx.database.tables['analytics.command']) {
      throw new Error('找不到历史数据表')
    }

    const [records, bindings] = await Promise.all([
      ctx.database.get('analytics.command', {}),
      ctx.database.get('binding', {})
    ])

    if (!records.length) throw new Error('历史数据为空')

    const userIdMap = new Map(bindings
      .filter(b => b.aid)
      .map(b => [b.aid.toString(), { pid: b.pid, platform: b.platform }]))

    const mergedRecords = new Map()

    // 如果是覆盖模式，清除现有数据
    if (overwrite) {
      await ctx.database.remove('analytics.stat', {})
      ctx.logger.info('已清除现有统计数据')
    }

    // 处理记录
    records.forEach(cmd => {
      const binding = userIdMap.get(cmd.userId?.toString())
      if (!binding || !cmd.channelId) return

      // 确保命令字段正确，普通消息使用 __message__
      const commandValue = cmd.name || '__message__'

      const key = `${binding.platform}:${cmd.channelId}:${binding.pid}:${commandValue}`
      const timestamp = new Date((cmd.date * 86400000) + ((cmd.hour || 0) * 3600000))

      if (isNaN(timestamp.getTime())) return

      const curr = mergedRecords.get(key) || {
        platform: binding.platform,
        guildId: cmd.channelId,
        userId: binding.pid,
        command: commandValue,
        count: 0,
        lastTime: timestamp,
        // 添加默认的名称字段
        userName: '',
        guildName: ''
      }

      curr.count += (cmd.count || 1)
      curr.lastTime = new Date(Math.max(curr.lastTime.getTime(), timestamp.getTime()))
      mergedRecords.set(key, curr)
    })

    const batch = Array.from(mergedRecords.values())
    let imported = 0
    let errors = 0

    ctx.logger.info(`准备导入 ${batch.length} 条历史记录...`)

    // 批量处理导入
    const batchSize = 100
    const batches = []
    for (let i = 0; i < batch.length; i += batchSize) {
      batches.push(batch.slice(i, i + batchSize))
    }

    for (let i = 0; i < batches.length; i++) {
      const currentBatch = batches[i]
      ctx.logger.info(`正在处理批次 ${i + 1}/${batches.length}...`)

      await Promise.all(currentBatch.map(async record => {
        try {
          const query = {
            platform: record.platform,
            guildId: record.guildId,
            userId: record.userId,
            command: record.command
          }

          const [existing] = await ctx.database.get('analytics.stat', query)
          if (existing && !overwrite) {
            await ctx.database.set('analytics.stat', query, {
              count: existing.count + record.count,
              lastTime: new Date(Math.max(existing.lastTime?.getTime() || 0, record.lastTime.getTime())),
              // 保留已有的名称字段
              userName: existing.userName || '',
              guildName: existing.guildName || ''
            })
          } else {
            await ctx.database.create('analytics.stat', {
              ...query,
              count: record.count,
              lastTime: record.lastTime,
              userName: record.userName || '',
              guildName: record.guildName || ''
            })
          }
          imported++
        } catch (e) {
          errors++
          ctx.logger.error(`导入记录失败: ${e.message}`, record)
        }
      }))
    }

    return `导入完成：成功导入 ${imported} 条记录${errors > 0 ? `，${errors} 条记录失败` : ''}`
  },

  /**
   * 清除统计数据
   * @param ctx Koishi上下文
   * @param options 清除选项
   * @returns 清除的记录数量
   */
  async clearStats(ctx: Context, options: {
    userId?: string
    platform?: string
    guildId?: string
    command?: string
  }) {
    if (!Object.values(options).some(Boolean)) {
      await ctx.database.drop('analytics.stat')
      await database.initialize(ctx)
      return -1
    }
    const query: any = {}
    for (const [key, value] of Object.entries(options)) {
      if (value) query[key] = value
    }
    const result = await ctx.database.remove('analytics.stat', query)
    return Number(result ?? 0)
  },

  /**
   * 导出统计数据到文件
   * @param ctx Koishi上下文
   * @param filename 导出的文件名
   * @param options 导出选项
   * @returns 导出结果
   */
  async exportToFile(ctx: Context, filename: string, options: {
    userId?: string
    platform?: string
    guildId?: string
    command?: string
    format?: 'json' | 'csv'
  }) {
    // 构建查询条件
    const query: any = {}
    for (const [key, value] of Object.entries(options)) {
      if (value && key !== 'format') query[key] = value
    }
    // 查询数据
    const records = await ctx.database.get('analytics.stat', query)
    if (!records.length) {
      throw new Error('没有找到匹配的记录')
    }
    const dataDir = path.join(process.cwd(), 'data')
    const format = options.format || 'json'
    const outputFilename = `${filename}.${format}`
    const filePath = path.join(dataDir, outputFilename)

    try {
      if (format === 'csv') {
        // CSV 格式导出
        const headers = ['platform', 'guildId', 'userId', 'command', 'userName', 'guildName', 'count', 'lastTime']
        // 过滤id字段
        const csvContent = [
          headers.join(','),
          ...records.map(record => headers.map(header => {
            const value = record[header]
            if (value === null || value === undefined) return ''
            if (header === 'lastTime') return new Date(value).toISOString()
            return typeof value === 'string'
              ? `"${value.replace(/"/g, '""')}"`
              : String(value)
          }).join(','))
        ].join('\n')

        fs.writeFileSync(filePath, csvContent, 'utf-8')
      } else {
        // JSON 格式导出
        const exportRecords = records.map(record => {
          const { id, ...rest } = record
          return rest
        })
        const fileContent = JSON.stringify(exportRecords, null, 2)
        fs.writeFileSync(filePath, fileContent, 'utf-8')
      }

      return {
        count: records.length,
        path: filePath,
        format,
        filename: outputFilename
      }
    } catch (e) {
      throw new Error(`写入文件失败: ${e.message}`)
    }
  },

  /**
   * 从文件导入统计数据
   * @param ctx Koishi上下文
   * @param filename 导入的文件名
   * @param overwrite 是否覆盖现有数据
   * @returns 导入结果
   */
  async importFromFile(ctx: Context, filename: string, overwrite = false) {
    try {
      const dataDir = path.join(process.cwd(), 'data')
      if (!path.extname(filename)) {
        // 首先尝试json格式
        if (fs.existsSync(path.join(dataDir, `${filename}.json`))) {
          filename = `${filename}.json`;
        }
        // 然后尝试csv格式
        else if (fs.existsSync(path.join(dataDir, `${filename}.csv`))) {
          filename = `${filename}.csv`;
        }
      }

      const actualPath = path.join(dataDir, filename)
      if (!fs.existsSync(actualPath)) {
        throw new Error(`文件 ${actualPath} 不存在`)
      }
      // 读取文件内容
      const fileContent = fs.readFileSync(actualPath, 'utf-8')
      let records: StatRecord[] = []
      // 根据文件扩展名判断格式
      const ext = path.extname(filename).toLowerCase()
      if (ext === '.csv') {
        // CSV解析
        const lines = fileContent.trim().split('\n')
        if (lines.length < 2) throw new Error('CSV文件格式不正确')
        const headers = lines[0].split(',')
        records = lines.slice(1).map(line => {
          // 改进CSV解析以处理引号内的逗号
          const values = []
          let inQuotes = false
          let currentValue = ''

          for (let i = 0; i < line.length; i++) {
            const char = line[i]
            if (char === '"') {
              if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
                // 处理双引号转义 ("") -> (")
                currentValue += '"'
                i++
              } else {
                // 切换引号状态
                inQuotes = !inQuotes
              }
            } else if (char === ',' && !inQuotes) {
              // 找到分隔符且不在引号内
              values.push(currentValue)
              currentValue = ''
            } else {
              // 普通字符
              currentValue += char
            }
          }
          // 添加最后一个值
          values.push(currentValue)
          // 构建记录对象
          const record: any = {}
          headers.forEach((header, index) => {
            if (header === 'id') return

            const value = values[index] || ''
            if (header === 'count') {
              record[header] = parseInt(value) || 0
            } else if (header === 'lastTime') {
              record[header] = value ? new Date(value) : new Date()
            } else {
              // 不再对userName和guildName做特殊处理，保留所有字段的值
              record[header] = value
            }
          })

          // 确保command字段存在，如果是空值，设置为__message__
          if (!record.command) {
            record.command = '__message__'
          }

          return record
        })
      } else {
        // JSON格式解析
        const parsedData = JSON.parse(fileContent)
        if (!Array.isArray(parsedData)) {
          throw new Error('文件内容不是有效的记录数组')
        }
        // 处理记录
        records = parsedData.map(record => {
          const { id, ...rest } = record

          // 确保 userName 和 guildName 被正确保留
          const userName = rest.userName !== undefined ? rest.userName : '';
          const guildName = rest.guildName !== undefined ? rest.guildName : '';

          // 确保必要字段存在
          const processedRecord = {
            ...rest,
            userName,  // 保留原始userName值
            guildName, // 保留原始guildName值
            // 确保 command 字段存在，为空时设置为 __message__
            command: rest.command || '__message__',
            // 确保数值和日期类型字段有效
            count: parseInt(String(rest.count)) || 1,
            lastTime: rest.lastTime ? new Date(rest.lastTime) : new Date()
          };

          return processedRecord as StatRecord
        })
      }

      // 如果覆盖模式，先清除现有数据
      if (overwrite) {
        await ctx.database.remove('analytics.stat', {})
        ctx.logger.info(`已清除现有统计数据`)
      }

      let importedCount = 0
      let skippedCount = 0
      let errorCount = 0
      let totalRecords = records.length

      ctx.logger.info(`开始导入 ${totalRecords} 条记录...`)
      // 分批处理
      const batchSize = 100
      const batches = []

      for (let i = 0; i < records.length; i += batchSize) {
        batches.push(records.slice(i, i + batchSize))
      }

      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i]
        ctx.logger.info(`正在处理批次 ${i + 1}/${batches.length}...`)

        await Promise.all(batch.map(async record => {
          // 验证必要字段
          if (!record.platform || !record.guildId || !record.userId) {
            ctx.logger.warn(`跳过无效记录: 缺少必要字段`, record)
            skippedCount++
            return
          }

          // 修复: 确保 command 字段能正确处理 "__message__"，不再视为空值
          if (record.command === undefined || record.command === null || record.command === '') {
            record.command = '__message__'
          }

          // 准备复合键查询条件
          const query = {
            platform: record.platform,
            guildId: record.guildId,
            userId: record.userId,
            command: record.command
          }

          try {
            // 检查记录是否已存在
            const existing = await ctx.database.get('analytics.stat', query)
            if (existing.length && !overwrite) {
              // 更新现有记录
              const updateData: any = {
                count: existing[0].count + (record.count || 1),
                lastTime: new Date(Math.max(existing[0].lastTime?.getTime() || 0, record.lastTime?.getTime() || Date.now())),
              }

              // 修复: 确保userName和guildName得到正确处理
              // 只有当导入记录中这些字段有值时才更新
              if (record.userName !== undefined && record.userName !== '') {
                updateData.userName = utils.sanitizeString(record.userName);
              }
              if (record.guildName !== undefined && record.guildName !== '') {
                updateData.guildName = utils.sanitizeString(record.guildName);
              }

              await ctx.database.set('analytics.stat', query, updateData)
            } else {
              // 创建新记录，确保所有必要字段都有值
              const newRecord = {
                platform: record.platform,
                guildId: record.guildId,
                userId: record.userId,
                command: record.command,
                count: record.count || 1,
                lastTime: record.lastTime ? new Date(record.lastTime) : new Date(),
                // 修复: 确保userName和guildName被正确保存
                userName: record.userName !== undefined ? utils.sanitizeString(record.userName) : '',
                guildName: record.guildName !== undefined ? utils.sanitizeString(record.guildName) : ''
              }

              await ctx.database.create('analytics.stat', newRecord)
            }
            importedCount++
          } catch (e) {
            errorCount++
            ctx.logger.warn(`导入记录失败(${errorCount}/${totalRecords}): ${e.message}`, record)
            skippedCount++
          }
        }))
      }

      ctx.logger.info(`导入完成: 成功 ${importedCount}, 跳过 ${skippedCount}, 错误 ${errorCount}`)
      return `成功导入 ${importedCount} 条记录${skippedCount > 0 ? `，跳过 ${skippedCount} 条无效记录` : ''}${errorCount > 0 ? `，${errorCount} 条记录导入失败` : ''}`
    } catch (e) {
      ctx.logger.error(`导入过程出错: ${e.message}`, e.stack)
      throw new Error(`导入失败: ${e.message}`)
    }
  }
}
