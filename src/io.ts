import { Context } from 'koishi'
import { StatRecord } from './index'
import { utils } from './utils'
import * as fs from 'fs'
import * as path from 'path'

/**
 * 获取统计数据目录
 */
function getStatDirectory(): string {
  const statDir = path.join(process.cwd(), 'data', 'stat')
  if (!fs.existsSync(statDir)) {
    fs.mkdirSync(statDir, { recursive: true })
  }
  return statDir
}

/**
 * I/O 操作相关函数
 */
export const io = {
  /**
   * 导出统计数据到文件
   */
  async exportToFile(ctx: Context, filename: string, options: {
    userId?: string
    platform?: string
    guildId?: string
    command?: string
    batchSize?: number
  }) {
    // 构建查询条件
    const query = Object.entries(options)
      .filter(([key, value]) => key !== 'batchSize' && Boolean(value))
      .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {})
    // 查询数据
    const records = await ctx.database.get('analytics.stat', query)
    if (!records.length) throw new Error('没有找到匹配的记录')
    // 生成文件名
    const timestamp = new Date().toISOString().replace(/[:T.]/g, '-').substring(0, 19)
    const batchSize = options.batchSize || 200
    const dataDir = getStatDirectory()
    // 处理批次
    const totalRecords = records.length
    const batches = Math.ceil(totalRecords / batchSize)
    const exportFiles = []

    ctx.logger.info(`正在导出${totalRecords}条统计记录...`)

    for (let batch = 0; batch < batches; batch++) {
      // 计算当前批次的数据范围
      const start = batch * batchSize
      const end = Math.min((batch + 1) * batchSize, totalRecords)
      const batchRecords = records.slice(start, end)
      // 确定输出文件名
      let outputFilename = batches === 1
        ? `${filename}-${timestamp}.json`
        : `${filename}-${timestamp}-${batch+1}-${batches}.json`

      const filePath = path.join(dataDir, outputFilename)

      try {
        const exportData = batchRecords.map(({ id, ...rest }) => rest)
        fs.writeFileSync(filePath, JSON.stringify(exportData, null, 2), 'utf-8')

        if (batches > 1) {
          ctx.logger.info(`批次 ${batch+1}/${batches} 导出完成，已导出到 ${filePath}`)
        }

        exportFiles.push({
          count: batchRecords.length,
          path: filePath,
          format: 'json',
          filename: outputFilename,
          batch: batch + 1,
          totalBatches: batches
        })
      } catch (e) {
        throw new Error(`写入文件失败 (批次 ${batch+1}): ${e.message}`)
      }
    }

    if (batches === 1) {
      ctx.logger.info(`导出完成，已导出到 ${exportFiles[0].path}`)
    }

    return {
      count: totalRecords,
      batches: batches,
      files: exportFiles
    }
  },

  /**
   * 列出可导入的文件
   */
  async listImportFiles(ctx: Context) {
    const dataDir = getStatDirectory()
    try {
      // 读取目录内容
      const files = await fs.promises.readdir(dataDir)
      // 过滤统计数据JSON文件
      const statFiles = files.filter(file =>
        file.endsWith('.json') &&
        (file.includes('stat') || file.includes('analytics'))
      )

      if (statFiles.length === 0) {
        return { files: [], fileInfo: {} }
      }
      // 收集文件信息和批次组
      const fileInfo = {}
      const batchGroups = new Map()
      const filesInBatchGroups = new Set()

      for (const file of statFiles) {
        const filePath = path.join(dataDir, file)
        const stats = await fs.promises.stat(filePath)
        // 检查是否是批次文件
        const batchMatch = file.match(/(.*)-(\d+)-(\d+)\.json$/)
        const isBatch = !!batchMatch

        let batchInfo = undefined
        if (isBatch) {
          const [, baseFilename, currentBatch, totalBatches] = batchMatch
          batchInfo = {
            base: baseFilename,
            current: parseInt(currentBatch),
            total: parseInt(totalBatches)
          }
          // 添加到批次组
          const key = `${baseFilename}-total${totalBatches}`
          if (!batchGroups.has(key)) {
            batchGroups.set(key, [])
          }
          batchGroups.get(key).push(file)
          // 记录该文件属于批次组
          filesInBatchGroups.add(file)
        }

        fileInfo[file] = {
          mtime: stats.mtime.toLocaleString(),
          isBatch,
          batchInfo
        }
      }
      // 生成批次组文件信息
      const batchGroupFiles = []
      batchGroups.forEach((files, key) => {
        if (files.length > 1) {
          // 提取批次组基本信息
          const groupInfo = files[0].match(/(.*)-(\d+)-(\d+)\.json$/)
          if (!groupInfo) return

          const [, baseFilename, , totalBatches] = groupInfo
          const groupName = `${baseFilename}-批次组(共${totalBatches}个)`
          // 计算最新修改时间
          let latestTime = new Date(0)

          files.forEach(file => {
            const info = fileInfo[file]
            const fileTime = new Date(info.mtime)
            if (fileTime > latestTime) {
              latestTime = fileTime
            }
          })
          // 添加批次组信息
          fileInfo[groupName] = {
            mtime: latestTime.toLocaleString(),
            isBatch: true,
            batchInfo: {
              base: baseFilename,
              current: 0,
              total: parseInt(totalBatches),
              files: files.sort((a, b) => {
                const aMatch = a.match(/-(\d+)-/);
                const bMatch = b.match(/-(\d+)-/);
                return (aMatch && bMatch) ?
                  (parseInt(aMatch[1]) - parseInt(bMatch[1])) : 0;
              })
            }
          }

          batchGroupFiles.push(groupName)
        }
      })

      // 过滤掉已经在批次组中的文件
      const filteredStatFiles = statFiles.filter(file => !filesInBatchGroups.has(file))

      // 合并所有文件列表并排序
      const allFiles = [...batchGroupFiles, ...filteredStatFiles]
      const sortedFiles = allFiles.sort((a, b) => {
        // 批次组优先
        const aIsGroup = a.includes('批次组')
        const bIsGroup = b.includes('批次组')
        if (aIsGroup !== bIsGroup) {
          return aIsGroup ? -1 : 1
        }
        // 按修改时间降序
        return new Date(fileInfo[b].mtime).getTime() - new Date(fileInfo[a].mtime).getTime()
      })

      return { files: sortedFiles, fileInfo }
    } catch (e) {
      ctx.logger.error(`读取数据目录失败: ${e.message}`)
      return { files: [], fileInfo: {} }
    }
  },

  /**
   * 从文件导入统计数据
   */
  async importFromFile(ctx: Context, filename: string, overwrite = false) {
    try {
      const dataDir = getStatDirectory()
      let files = []

      // 处理批次组内特定文件 (格式: "组序号-文件序号")
      const batchItemMatch = /^(\d+)-(\d+)$/.exec(filename)
      if (batchItemMatch) {
        const [, groupIndex, fileIndex] = batchItemMatch
        // 获取文件列表
        const { files: filesList, fileInfo } = await this.listImportFiles(ctx)

        // 检查组序号是否有效
        const groupIdx = parseInt(groupIndex) - 1
        if (groupIdx < 0 || groupIdx >= filesList.length || !filesList[groupIdx].includes('批次组')) {
          throw new Error(`批次组序号 ${groupIndex} 无效`)
        }

        const groupName = filesList[groupIdx]
        const groupInfo = fileInfo[groupName]?.batchInfo
        if (!groupInfo || !groupInfo.files) {
          throw new Error(`无法获取批次组 ${groupName} 的文件列表`)
        }

        // 检查文件序号是否有效
        const fileIdx = parseInt(fileIndex) - 1
        if (fileIdx < 0 || fileIdx >= groupInfo.files.length) {
          throw new Error(`文件序号 ${fileIndex} 无效，批次组内共有 ${groupInfo.files.length} 个文件`)
        }

        // 获取指定文件
        const targetFile = groupInfo.files[fileIdx]
        if (fs.existsSync(path.join(dataDir, targetFile))) {
          files.push(targetFile)
          ctx.logger.info(`从批次组 ${groupName} 中选择文件: ${targetFile}`)
        } else {
          throw new Error(`找不到文件: ${targetFile}`)
        }
      }
      // 处理批次组文件
      else if (filename.includes('批次组')) {
        const batchMatch = filename.match(/(.*)-批次组\(共(\d+)个\)$/)
        if (batchMatch) {
          const [, baseFilename, totalBatches] = batchMatch
          // 收集所有批次文件
          for (let i = 1; i <= parseInt(totalBatches); i++) {
            const batchFile = `${baseFilename}-${i}-${totalBatches}.json`
            if (fs.existsSync(path.join(dataDir, batchFile))) {
              files.push(batchFile)
            }
          }

          if (files.length === 0) {
            throw new Error(`找不到批次文件`)
          }

          ctx.logger.info(`找到${files.length}个批次文件`)
        } else {
          throw new Error(`无效的批次组文件名`)
        }
      }
      // 处理单个批次文件
      else if (filename.match(/(.*)-(\d+)-(\d+)\.json$/)) {
        const filePath = path.join(dataDir, filename)
        if (fs.existsSync(filePath)) {
          files.push(filename)
        } else {
          throw new Error(`找不到批次文件`)
        }
      }
      // 处理常规单文件
      else {
        // 自动添加扩展名
        const fileToCheck = !filename.endsWith('.json') ? filename + '.json' : filename
        const filePath = path.join(dataDir, fileToCheck)

        if (fs.existsSync(filePath)) {
          files.push(fileToCheck)
        } else {
          throw new Error(`文件不存在`)
        }
      }

      // 如果是覆盖模式，先清除数据
      if (overwrite) {
        await ctx.database.remove('analytics.stat', {})
        ctx.logger.info('已清除现有数据')
      }

      const totalFiles = files.length
      ctx.logger.info(`正在${overwrite ? '覆盖' : ''}导入${totalFiles > 1 ? `${totalFiles}个文件的` : ''}统计记录...`)
      // 导入处理
      let totalStats = { imported: 0, skipped: 0, errors: 0, invalidRecords: 0 }
      // 依次处理每个文件
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        const filePath = path.join(dataDir, file)

        if (files.length > 1) {
          ctx.logger.info(`处理文件 ${i+1}/${files.length}`)
        }

        try {
          // 读取文件内容
          const content = await fs.promises.readFile(filePath, 'utf-8')

          if (!content || content.trim() === '') {
            throw new Error('文件内容为空')
          }
          // 解析并导入数据
          const { validRecords, invalidRecords } = this.parseJSON(content)
          ctx.logger.info(`解析: ${validRecords.length}个有效记录`)
          // 导入记录
          const result = await this.importRecords(ctx, validRecords)
          // 累计统计
          totalStats.imported += result.imported
          totalStats.skipped += result.skipped
          totalStats.errors += result.errors
          totalStats.invalidRecords += invalidRecords

          if (files.length > 1) {
            ctx.logger.info(`批次 ${i+1}/${files.length} 导入完成，已导入 ${result.imported}/${validRecords.length} 条记录（成功${result.imported}/跳过${result.skipped}/失败${result.errors}）`)
          } else {
            ctx.logger.info(`批次 1/1 导入完成，已导入 ${result.imported}/${validRecords.length} 条记录（成功${result.imported}/跳过${result.skipped}/失败${result.errors}）`)
          }
        } catch (err) {
          throw new Error(`处理失败: ${err.message}`)
        }
      }
      // 返回导入结果
      let resultMsg = `导入成功（${totalStats.imported}条）`
      if (totalStats.errors) resultMsg += `，${totalStats.errors}条失败`
      if (totalStats.invalidRecords) resultMsg += `，${totalStats.invalidRecords}条无效`

      return resultMsg
    } catch (e) {
      throw new Error(`导入失败：${e.message}`)
    }
  },

  /**
   * 导入历史数据
   */
  async importLegacyData(ctx: Context, overwrite = false) {
    if (!ctx.database.tables['analytics.command']) {
      throw new Error('找不到历史数据表')
    }
    // 获取历史记录和绑定数据
    const [records, bindings] = await Promise.all([
      ctx.database.get('analytics.command', {}),
      ctx.database.get('binding', {})
    ])

    if (!records.length) throw new Error('历史数据为空')
    ctx.logger.info(`正在导入${records.length}条历史统计记录...`)

    // 建立用户ID映射
    const userIdMap = new Map(
      bindings
        .filter(b => b.aid)
        .map(b => [b.aid.toString(), { pid: b.pid, platform: b.platform }])
    )
    // 合并相同记录
    const mergedRecords = new Map()
    // 如果是覆盖模式，清除现有数据
    if (overwrite) {
      await ctx.database.remove('analytics.stat', {})
      ctx.logger.info('已清除现有统计数据')
    }
    // 处理每条历史记录
    records.forEach(cmd => {
      const binding = userIdMap.get(cmd.userId?.toString())
      if (!binding || !cmd.channelId) return
      // 生成唯一键并设置记录值
      const commandValue = cmd.name || 'mess_age'
      const key = `${binding.platform}:${cmd.channelId}:${binding.pid}:${commandValue}`
      const timestamp = new Date((cmd.date * 86400000) + ((cmd.hour || 0) * 3600000))

      if (isNaN(timestamp.getTime())) return
      // 合并相同记录
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
    // 执行导入
    const batch = Array.from(mergedRecords.values())
    const result = await this.importRecords(ctx, batch)

    return `导入完成：成功导入 ${result.imported} 条记录${result.errors > 0 ? `，${result.errors} 条记录失败` : ''}`
  },

  /**
   * 解析JSON数据
   */
  parseJSON(content: string) {
    try {
      const data = JSON.parse(content)
      if (!Array.isArray(data)) throw new Error('JSON文件必须包含记录数组')

      let invalidRecords = 0
      const validRecords = []

      // 筛选并处理有效记录
      for (const record of data) {
        // 检查必要字段
        if (!record.platform || !record.guildId || !record.userId || !record.command) {
          invalidRecords++
          continue
        }
        // 提取有效字段
        const { id, ...rest } = record
        validRecords.push({
          ...rest,
          platform: rest.platform,
          guildId: rest.guildId,
          userId: rest.userId,
          userName: rest.userName ?? '',
          guildName: rest.guildName ?? '',
          command: rest.command,
          count: parseInt(String(rest.count)) || 1,
          lastTime: rest.lastTime ? new Date(rest.lastTime) : new Date()
        })
      }

      return { validRecords, totalRecords: data.length, invalidRecords }
    } catch (error) {
      throw new Error(`JSON解析错误: ${error.message}`)
    }
  },

  /**
   * 导入记录到数据库
   */
  async importRecords(ctx: Context, records: StatRecord[]) {
    let imported = 0, skipped = 0, errors = 0
    const totalRecords = records.length

    ctx.logger.info(`开始导入 ${totalRecords} 条记录`)

    const batchSize = 100
    const processName = (name: string, id: string): string => {
      if (!name) return '';
      // 清洗处理名称
      let cleanName = utils.sanitizeString(name);
      // 过滤无意义名称
      if (!cleanName || /^[\s*□]+$/.test(cleanName)) return '';
      // 如果名称与ID相同，返回空
      if (id && (cleanName === id || cleanName.includes(id))) return '';

      return cleanName;
    };
    // 分批处理记录
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize)
      const batchNum = Math.floor(i / batchSize) + 1
      const totalBatches = Math.ceil(records.length / batchSize)

      ctx.logger.info(`处理批次 ${batchNum}/${totalBatches} (${i}-${Math.min(i + batchSize, records.length)})`)
      // 并行处理每条记录
      await Promise.all(batch.map(async record => {
        const query = {
          platform: record.platform,
          guildId: record.guildId,
          userId: record.userId,
          command: record.command
        }

        try {
          // 查询现有记录
          const [existing] = await ctx.database.get('analytics.stat', query)

          if (existing) {
            // 更新现有记录
            let newUserName = '';
            let newGuildName = '';
            // 处理用户名 - 比较双方记录，选择有效的或更新的
            const existingUserName = existing.userName?.trim() || '';
            const recordUserName = processName(record.userName, record.userId);

            if (existingUserName && recordUserName) {
              // 两者都存在，使用较新记录的名称
              newUserName = record.lastTime > existing.lastTime ? recordUserName : existingUserName;
            } else {
              // 只有一个存在，使用存在的那个
              newUserName = existingUserName || recordUserName;
            }
            // 处理群组名
            const existingGuildName = existing.guildName?.trim() || '';
            const recordGuildName = processName(record.guildName, record.guildId);

            if (existingGuildName && recordGuildName) {
              newGuildName = record.lastTime > existing.lastTime ? recordGuildName : existingGuildName;
            } else {
              newGuildName = existingGuildName || recordGuildName;
            }
            // 更新记录
            await ctx.database.set('analytics.stat', query, {
              count: existing.count + (record.count || 1),
              lastTime: record.lastTime > existing.lastTime ? record.lastTime : existing.lastTime,
              userName: newUserName,
              guildName: newGuildName
            })
          } else {
            // 创建新记录
            await ctx.database.create('analytics.stat', {
              ...query,
              count: record.count || 1,
              lastTime: record.lastTime || new Date(),
              userName: processName(record.userName, record.userId),
              guildName: processName(record.guildName, record.guildId)
            })
          }
          imported++
        } catch (e) {
          ctx.logger.error(`导入记录失败: ${e.message}`, query)
          errors++
        }
      }))
      // 报告进度
      if ((i + batchSize) % 1000 === 0 || i + batchSize >= records.length) {
        ctx.logger.info(`已处理 ${Math.min(i + batchSize, records.length)}/${records.length} 条记录 (${imported} 成功, ${skipped} 跳过, ${errors} 失败)`)
      }
    }

    return { imported, skipped, errors }
  }
}