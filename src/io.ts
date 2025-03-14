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
  }) {
    // 构建查询条件
    const query = Object.entries(options)
      .filter(([_, value]) => Boolean(value))
      .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {})

    // 查询数据
    const records = await ctx.database.get('analytics.stat', query)
    if (!records.length) throw new Error('没有找到匹配的记录')

    const outputFilename = `${filename}.json`
    const dataDir = path.join(process.cwd(), 'data')
    const filePath = path.join(dataDir, outputFilename)

    try {
      // JSON 格式导出
      const exportRecords = records.map(({ id, ...rest }) => rest)
      fs.writeFileSync(filePath, JSON.stringify(exportRecords, null, 2), 'utf-8')

      return {
        count: records.length,
        path: filePath,
        format: 'json',
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
        }
      }

      const filePath = path.join(dataDir, filename)
      if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filename}`)

      // 获取文件大小
      const stats = fs.statSync(filePath)
      const fileSizeMB = stats.size / (1024 * 1024)
      ctx.logger.info(`导入文件大小: ${fileSizeMB.toFixed(2)}MB`)

      let fileContent: string
      try {
        // 使用异步读取替代同步读取，更适合大文件
        fileContent = await fs.promises.readFile(filePath, { encoding: 'utf-8' })

        // 确保文件内容完整
        if (!fileContent || fileContent.trim() === '') {
          throw new Error('文件内容为空')
        }

        if (!fileContent.endsWith(']') && fileContent.startsWith('[')) {
          throw new Error('JSON文件不完整，可能被截断')
        }
      } catch (err) {
        throw new Error(`读取文件失败: ${err.message}`)
      }

      let records
      try {
        // 解析JSON数据
        const parseResult = this.parseJSON(fileContent)
        records = parseResult.validRecords

        // 打印解析结果详情
        ctx.logger.info(`JSON解析完成: 总记录数 ${parseResult.totalRecords}, 有效记录 ${records.length}, 无效记录 ${parseResult.invalidRecords}`)
        if (parseResult.invalidRecords > 0) {
          ctx.logger.warn(`发现 ${parseResult.invalidRecords} 条记录缺少必要字段，这些记录将被跳过`)
        }
      } catch (err) {
        throw new Error(`解析JSON失败: ${err.message}`)
      }

      // 如果覆盖模式，先清除数据
      if (overwrite) await ctx.database.remove('analytics.stat', {})

      // 分批处理导入，避免一次处理过多数据导致内存问题
      const result = await this.importRecords(ctx, records)
      return `成功导入 ${result.imported} 条记录${result.skipped ? `，跳过 ${result.skipped} 条无效记录` : ''}${result.errors ? `，${result.errors} 条导入失败` : ''}${result.invalidCount ? `\n注意：原始文件中有 ${result.invalidCount} 条记录因缺少必要字段未被导入` : ''}`
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

      // 确保命令字段正确
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
    // 修复: 将_importRecords改为importRecords
    const result = await this.importRecords(ctx, batch)

    return `导入完成：成功导入 ${result.imported} 条记录${result.errors > 0 ? `，${result.errors} 条记录失败` : ''}`
  },

  // 改进的JSON解析方法，增加了对不完整记录的处理
  parseJSON(content: string): { validRecords: StatRecord[], totalRecords: number, invalidRecords: number } {
    try {
      const data = JSON.parse(content)
      if (!Array.isArray(data)) throw new Error('JSON文件必须包含记录数组')

      const totalRecords = data.length
      let invalidRecords = 0

      // 筛选出有效记录并进行标准化处理
      const validRecords = data.reduce((acc, record) => {
        // 检查记录是否包含所有必要字段
        if (!record.platform || !record.guildId || !record.userId || !record.command) {
          invalidRecords++
          return acc
        }

        const { id, ...rest } = record
        // 添加有效记录到结果数组
        acc.push({
          ...rest,
          // 规范化字段值
          platform: rest.platform || 'unknown',
          guildId: rest.guildId || 'unknown',
          userId: rest.userId || 'unknown',
          userName: rest.userName ?? '',
          guildName: rest.guildName ?? '',
          command: rest.command || 'unknown',
          count: parseInt(String(rest.count)) || 1,
          lastTime: rest.lastTime ? new Date(rest.lastTime) : new Date()
        })
        return acc
      }, [] as StatRecord[])

      return {
        validRecords,
        totalRecords,
        invalidRecords
      }
    } catch (error) {
      throw new Error(`JSON解析错误: ${error.message}`)
    }
  },

  // 改进: 导入记录方法
  async importRecords(ctx: Context, records: StatRecord[]) {
    let imported = 0, skipped = 0, errors = 0
    const totalRecords = records.length
    const invalidCount = 0  // 将在parseJSON中处理，这里只处理有效记录

    ctx.logger.info(`开始导入 ${totalRecords} 条有效记录`)

    // 增加批处理大小，使处理更高效
    const batchSize = 100

    // 辅助函数：处理名称
    const processName = (name: string, id: string): string => {
      if (!name) return '';

      // 增强的名称清洗处理
      let cleanName = utils.sanitizeString(name);

      // 如果清洗后为空或仅有无意义字符
      if (!cleanName || /^[\s*□]+$/.test(cleanName)) return '';

      // 检查名称是否与ID相同或包含ID（常见于默认名称）
      if (id && (cleanName === id || cleanName.includes(id))) return '';

      return cleanName;
    };

    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize)
      const currentBatch = Math.floor(i / batchSize) + 1
      const totalBatches = Math.ceil(records.length / batchSize)

      ctx.logger.info(`处理批次 ${currentBatch}/${totalBatches} (${i}-${Math.min(i + batchSize, records.length)})`)

      await Promise.all(batch.map(async record => {
        // 尝试导入所有有效记录
        const query = {
          platform: record.platform,
          guildId: record.guildId,
          userId: record.userId,
          command: record.command
        }

        try {
          const [existing] = await ctx.database.get('analytics.stat', query)

          if (existing) {
            // 处理 userName: 优先使用原记录非空值
            let newUserName = '';
            if (existing.userName && existing.userName.trim() !== '') {
              newUserName = existing.userName;
            } else if (record.userName !== undefined) {
              // 加强处理用户名
              newUserName = processName(record.userName, record.userId);
            }

            // 处理 guildName: 优先使用原记录非空值
            let newGuildName = '';
            if (existing.guildName && existing.guildName.trim() !== '') {
              newGuildName = existing.guildName;
            } else if (record.guildName !== undefined) {
              // 加强处理群组名
              newGuildName = processName(record.guildName, record.guildId);
            }

            await ctx.database.set('analytics.stat', query, {
              count: existing.count + (record.count || 1),
              lastTime: new Date(Math.max(existing.lastTime?.getTime() || 0, record.lastTime?.getTime() || Date.now())),
              userName: newUserName,
              guildName: newGuildName
            })
          } else {
            // 处理新记录的 userName 和 guildName
            const newUserName = processName(record.userName, record.userId);
            const newGuildName = processName(record.guildName, record.guildId);

            await ctx.database.create('analytics.stat', {
              ...query,
              count: record.count || 1,
              lastTime: record.lastTime || new Date(),
              userName: newUserName,
              guildName: newGuildName
            })
          }
          imported++
        } catch (e) {
          ctx.logger.error(`导入记录失败: ${e.message}`, query)
          errors++
        }
      }))

      // 报告当前进度
      if ((i + batchSize) % 1000 === 0 || i + batchSize >= records.length) {
        ctx.logger.info(`已处理 ${Math.min(i + batchSize, records.length)}/${records.length} 条记录 (${imported} 成功, ${skipped} 跳过, ${errors} 失败)`)
      }
    }

    return { imported, skipped, errors, invalidCount }
  }
}