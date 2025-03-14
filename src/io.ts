import { Context } from 'koishi'
import { StatRecord } from './index'
import { utils } from './utils'
import * as fs from 'fs'
import * as path from 'path'

export const io = {
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
    const query = Object.entries(options)
      .filter(([key, value]) => value && key !== 'format')
      .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {})

    // 查询数据
    const records = await ctx.database.get('analytics.stat', query)
    if (!records.length) throw new Error('没有找到匹配的记录')

    const format = options.format || 'json'
    const outputFilename = `${filename}.${format}`
    const dataDir = path.join(process.cwd(), 'data')
    const filePath = path.join(dataDir, outputFilename)

    try {
      if (format === 'csv') {
        // CSV 格式导出
        const headers = ['platform', 'guildId', 'userId', 'command', 'userName', 'guildName', 'count', 'lastTime']
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
        const exportRecords = records.map(({ id, ...rest }) => rest)
        fs.writeFileSync(filePath, JSON.stringify(exportRecords, null, 2), 'utf-8')
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
      // 自动添加扩展名
      if (!path.extname(filename)) {
        if (fs.existsSync(path.join(dataDir, `${filename}.json`))) {
          filename = `${filename}.json`;
        } else if (fs.existsSync(path.join(dataDir, `${filename}.csv`))) {
          filename = `${filename}.csv`;
        }
      }

      const filePath = path.join(dataDir, filename)
      if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filename}`)

      const fileContent = fs.readFileSync(filePath, 'utf-8')
      const ext = path.extname(filename).toLowerCase()
      let records: StatRecord[] = []

      if (ext === '.csv') {
        records = this._parseCSV(fileContent)
      } else {
        records = this._parseJSON(fileContent)
      }

      // 如果覆盖模式，先清除数据
      if (overwrite) await ctx.database.remove('analytics.stat', {})

      const result = await this._importRecords(ctx, records)
      return `成功导入 ${result.imported} 条记录${result.skipped ? `，跳过 ${result.skipped} 条无效记录` : ''}${result.errors ? `，${result.errors} 条导入失败` : ''}`
    } catch (e) {
      throw new Error(`导入失败: ${e.message}`)
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

      // 确保命令字段正确，普通消息使用 mmeessssaaggee
      const commandValue = cmd.name || 'mmeessssaaggee'

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
        userName: '',
        guildName: ''
      }

      curr.count += (cmd.count || 1)
      curr.lastTime = new Date(Math.max(curr.lastTime.getTime(), timestamp.getTime()))
      mergedRecords.set(key, curr)
    })

    const batch = Array.from(mergedRecords.values())
    const result = await this._importRecords(ctx, batch)

    return `导入完成：成功导入 ${result.imported} 条记录${result.errors > 0 ? `，${result.errors} 条记录失败` : ''}`
  },

  // 辅助方法: 解析CSV
  _parseCSV(content: string): StatRecord[] {
    const lines = content.trim().split('\n')
    if (lines.length < 2) throw new Error('CSV文件格式不正确')

    const headers = lines[0].split(',')
    return lines.slice(1).map(line => {
      const values = []
      let inQuotes = false
      let currentValue = ''

      for (let i = 0; i < line.length; i++) {
        const char = line[i]
        if (char === '"') {
          if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
            currentValue += '"'
            i++
          } else {
            inQuotes = !inQuotes
          }
        } else if (char === ',' && !inQuotes) {
          values.push(currentValue)
          currentValue = ''
        } else {
          currentValue += char
        }
      }
      values.push(currentValue)

      const record: any = {}
      headers.forEach((header, index) => {
        if (header === 'id') return
        const value = values[index] || ''

        if (header === 'count') {
          record[header] = parseInt(value) || 0
        } else if (header === 'lastTime') {
          record[header] = value ? new Date(value) : new Date()
        } else {
          record[header] = value
        }
      })

      if (!record.command) record.command = 'mmeessssaaggee'
      return record
    })
  },

  // 辅助方法: 解析JSON
  _parseJSON(content: string): StatRecord[] {
    const data = JSON.parse(content)
    if (!Array.isArray(data)) throw new Error('JSON文件必须包含记录数组')

    return data.map(({ id, ...rest }) => ({
      ...rest,
      userName: rest.userName ?? '',
      guildName: rest.guildName ?? '',
      command: rest.command || 'mmeessssaaggee',
      count: parseInt(String(rest.count)) || 1,
      lastTime: rest.lastTime ? new Date(rest.lastTime) : new Date()
    })) as StatRecord[]
  },

  // 辅助方法: 导入记录
  async _importRecords(ctx: Context, records: StatRecord[]) {
    let imported = 0, skipped = 0, errors = 0

    const batchSize = 100
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize)

      await Promise.all(batch.map(async record => {
        if (!record.platform || !record.guildId || !record.userId) {
          skipped++
          return
        }

        const query = {
          platform: record.platform,
          guildId: record.guildId,
          userId: record.userId,
          command: record.command
        }

        try {
          const [existing] = await ctx.database.get('analytics.stat', query)

          if (existing) {
            await ctx.database.set('analytics.stat', query, {
              count: existing.count + (record.count || 1),
              lastTime: new Date(Math.max(existing.lastTime?.getTime() || 0, record.lastTime?.getTime() || Date.now())),
              // 修复: 使用 !== undefined 而不是 truthy 检查，确保空字符串也会被正确导入
              userName: record.userName !== undefined ? utils.sanitizeString(record.userName) : existing.userName || '',
              guildName: record.guildName !== undefined ? utils.sanitizeString(record.guildName) : existing.guildName || ''
            })
          } else {
            await ctx.database.create('analytics.stat', {
              ...query,
              count: record.count || 1,
              lastTime: record.lastTime || new Date(),
              userName: record.userName ? utils.sanitizeString(record.userName) : '',
              guildName: record.guildName ? utils.sanitizeString(record.guildName) : ''
            })
          }
          imported++
        } catch (e) {
          errors++
        }
      }))
    }

    return { imported, skipped, errors }
  }
}