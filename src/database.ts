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
        platform: { type: 'string', length: 60 },
        guildId: { type: 'string', length: 150 },
        userId: { type: 'string', length: 150 },
        command: { type: 'string', length: 150, nullable: true },
        guildName: { type: 'string', nullable: true },
        userName: { type: 'string', nullable: true },
        count: 'unsigned',
        lastTime: 'timestamp',
      }, {
        primary: ['platform', 'guildId', 'userId', 'command'],
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
    data.command = (data.command === null || data.command === '') ? '' : data.command
    data.userName = data.userName === null ? '' : (data.userName || '')
    data.guildName = data.guildName === null ? '' : (data.guildName || '')

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
      const commandValue = (data.command === null || data.command === '') ? '' : data.command
      const query = {
        platform: data.platform,
        guildId: data.guildId,
        userId: data.userId,
        command: commandValue
      }
      const userName = utils.sanitizeString(data.userName || '')
      const guildName = utils.sanitizeString(data.guildName || '')
      const existing = await ctx.database.get('analytics.stat', query)
      if (existing.length) {
        await ctx.database.set('analytics.stat', query, {
          userName: userName || existing[0].userName || '',
          guildName: guildName || existing[0].guildName || '',
          count: existing[0].count + 1,
          lastTime: new Date()
        })
      } else {
        await ctx.database.create('analytics.stat', {
          ...query,
          userName: userName || '',
          guildName: guildName || '',
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
    overwrite && await ctx.database.remove('analytics.stat', {})
    records.forEach(cmd => {
      const binding = userIdMap.get(cmd.userId?.toString())
      if (!binding || !cmd.channelId) return
      const key = `${binding.platform}:${cmd.channelId}:${binding.pid}:${cmd.name || ''}`
      const timestamp = new Date((cmd.date * 86400000) + ((cmd.hour || 0) * 3600000))
      if (isNaN(timestamp.getTime())) return
      const curr = mergedRecords.get(key) || {
        platform: binding.platform,
        guildId: cmd.channelId,
        userId: binding.pid,
        command: cmd.name || null,
        count: 0,
        lastTime: timestamp
      }
      curr.count += (cmd.count || 1)
      curr.lastTime = new Date(Math.max(curr.lastTime.getTime(), timestamp.getTime()))
      mergedRecords.set(key, curr)
    })
    const batch = Array.from(mergedRecords.values())
    let imported = 0
    await Promise.all(batch.map(async record => {
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
          userName: utils.sanitizeString(existing.userName) || '',
          guildName: utils.sanitizeString(existing.guildName) || ''
        })
      } else {
        await ctx.database.create('analytics.stat', {
          ...query,
          ...record,
          userName: '',
          guildName: ''
        })
      }
      imported++
    }))
    return `导入完成：成功导入 ${imported} 条记录`
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
    pretty?: boolean
    format?: 'json' | 'csv'
  }) {
    // 构建查询条件
    const query: any = {}
    for (const [key, value] of Object.entries(options)) {
      if (value && !['pretty', 'format'].includes(key)) query[key] = value
    }

    // 查询数据
    const records = await ctx.database.get('analytics.stat', query)
    if (!records.length) {
      throw new Error('没有找到匹配的记录')
    }

    // 确保data目录存在
    const dataDir = path.join(process.cwd(), 'data')
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }

    // 使用固定的文件名
    const format = options.format || 'json'
    const outputFilename = `${filename}.${format}`
    const filePath = path.join(dataDir, outputFilename)

    try {
      if (format === 'csv') {
        // CSV 格式导出
        const headers = ['platform', 'guildId', 'userId', 'command', 'userName', 'guildName', 'count', 'lastTime']
        const csvContent = [
          headers.join(','), // 表头
          ...records.map(record => headers.map(header => {
            const value = record[header]
            if (value === null || value === undefined) return ''
            if (header === 'lastTime') return new Date(value).toISOString()
            // 确保字符串中的逗号不会破坏CSV格式
            return typeof value === 'string'
              ? `"${value.replace(/"/g, '""')}"`
              : String(value)
          }).join(','))
        ].join('\n')

        fs.writeFileSync(filePath, csvContent, 'utf-8')
      } else {
        // JSON 格式导出
        const fileContent = options.pretty
          ? JSON.stringify(records, null, 2)
          : JSON.stringify(records)
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
      // 在 data 目录下查找文件
      const dataDir = path.join(process.cwd(), 'data')

      // 如果未指定扩展名，尝试添加
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
        // CSV解析简化处理
        const lines = fileContent.trim().split('\n')
        if (lines.length < 2) throw new Error('CSV文件格式不正确')

        const headers = lines[0].split(',')
        records = lines.slice(1).map(line => {
          // 简单CSV解析，不处理引号内逗号的情况
          const values = line.split(',')
          const record: any = {}

          headers.forEach((header, index) => {
            const value = values[index] || ''
            if (header === 'count') {
              record[header] = parseInt(value) || 0
            } else if (header === 'lastTime') {
              record[header] = value ? new Date(value) : new Date()
            } else {
              record[header] = value
            }
          })

          return record
        })
      } else {
        // JSON格式解析
        records = JSON.parse(fileContent)
        if (!Array.isArray(records)) {
          throw new Error('文件内容不是有效的记录数组')
        }
      }

      // 如果覆盖模式，先清除现有数据
      if (overwrite) {
        await ctx.database.remove('analytics.stat', {})
      }

      // 简化批量导入
      let importedCount = 0
      await Promise.all(records.map(async record => {
        if (!record.platform || !record.guildId || !record.userId) return

        const query = {
          platform: record.platform,
          guildId: record.guildId,
          userId: record.userId,
          command: record.command || ''
        }

        try {
          // 检查记录是否已存在
          const existing = await ctx.database.get('analytics.stat', query)
          if (existing.length && !overwrite) {
            // 更新现有记录
            await ctx.database.set('analytics.stat', query, {
              count: existing[0].count + (record.count || 1),
              lastTime: new Date(Math.max(existing[0].lastTime?.getTime() || 0, record.lastTime?.getTime() || Date.now())),
              userName: utils.sanitizeString(record.userName || existing[0].userName || ''),
              guildName: utils.sanitizeString(record.guildName || existing[0].guildName || '')
            })
          } else {
            // 创建新记录
            await ctx.database.create('analytics.stat', {
              ...query,
              count: record.count || 1,
              lastTime: new Date(record.lastTime || Date.now()),
              userName: utils.sanitizeString(record.userName || ''),
              guildName: utils.sanitizeString(record.guildName || '')
            })
          }
          importedCount++
        } catch (e) {
          ctx.logger.warn(`导入记录失败: ${e.message}`, record)
        }
      }))

      return `成功导入 ${importedCount} 条记录`
    } catch (e) {
      throw new Error(`导入失败: ${e.message}`)
    }
  }
}
