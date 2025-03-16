import { Context } from 'koishi'
import { StatRecord } from './index'
import { utils } from './utils'
import * as fs from 'fs'
import * as path from 'path'

// 获取统计数据目录
function getStatDirectory(): string {
  const statDir = path.join(process.cwd(), 'data', 'stat')
  if (!fs.existsSync(statDir)) {
    fs.mkdirSync(statDir, { recursive: true })
  }
  return statDir
}

export const io = {
  // 导出统计数据到文件
  async exportToFile(ctx: Context, filename: string, options: {
    userId?: string, platform?: string, guildId?: string, command?: string, batchSize?: number
  }) {
    const query = Object.fromEntries(
      Object.entries(options).filter(([k, v]) => k !== 'batchSize' && Boolean(v))
    );

    const records = await ctx.database.get('analytics.stat', query)
    if (!records.length) throw new Error('历史数据为空')

    const timestamp = new Date().toISOString().replace(/[:T.]/g, '-').substring(0, 19)
    const batchSize = options.batchSize || 200
    const totalRecords = records.length
    const batches = Math.ceil(totalRecords / batchSize)
    const exportFiles = []

    for (let batch = 0; batch < batches; batch++) {
      const start = batch * batchSize
      const end = Math.min((batch + 1) * batchSize, totalRecords)
      const batchRecords = records.slice(start, end)

      const outputFilename = batches === 1
        ? `${filename}-${timestamp}.json`
        : `${filename}-${timestamp}-${batch+1}-${batches}.json`
      const filePath = path.join(getStatDirectory(), outputFilename)

      try {
        fs.writeFileSync(
          filePath,
          JSON.stringify(batchRecords.map(({ id, ...rest }) => rest), null, 2),
          'utf-8'
        )

        exportFiles.push({
          count: batchRecords.length,
          path: filePath,
          filename: outputFilename,
          batch: batch + 1,
          totalBatches: batches
        })
      } catch (e) {
        throw new Error(`导出失败（${batch+1}/${batches}）：${e.message}`)
      }
    }

    return { count: totalRecords, batches, files: exportFiles }
  },

  // 列出可导入的文件
  async listImportFiles(ctx: Context) {
    try {
      const files = await fs.promises.readdir(getStatDirectory())
      const statFiles = files.filter(file =>
        file.endsWith('.json') && (file.includes('stat') || file.includes('analytics'))
      )

      if (!statFiles.length) return { files: [], fileInfo: {} }

      const fileInfo = {}
      const batchGroups = new Map()
      // 处理文件信息
      for (const file of statFiles) {
        const stats = await fs.promises.stat(path.join(getStatDirectory(), file))
        const batchMatch = file.match(/(.*)-(\d+)-(\d+)\.json$/)
        const isBatch = !!batchMatch

        fileInfo[file] = {
          mtime: stats.mtime.toLocaleString(),
          timestamp: stats.mtime.getTime(),
          isBatch,
          batchInfo: isBatch ? {
            base: batchMatch[1],
            current: parseInt(batchMatch[2]),
            total: parseInt(batchMatch[3])
          } : undefined
        }
        // 收集批次组
        if (isBatch) {
          const [, base, , total] = batchMatch
          const key = `${base}-total${total}`
          if (!batchGroups.has(key)) batchGroups.set(key, [])
          batchGroups.get(key).push(file)
        }
      }
      // 处理批次组
      const batchGroupFiles = []
      for (const [, files] of batchGroups.entries()) {
        if (files.length <= 1) continue

        const firstFile = files[0]
        const groupInfo = firstFile.match(/(.*)-(\d+)-(\d+)\.json$/)
        if (!groupInfo) continue

        const [, base, , total] = groupInfo
        const groupName = `${base}(N=${total})`

        fileInfo[groupName] = {
          mtime: new Date(Math.max(...files.map(f => fileInfo[f].timestamp))).toLocaleString(),
          timestamp: Math.max(...files.map(f => fileInfo[f].timestamp)),
          isBatch: true,
          isGroup: true,
          batchInfo: {
            base,
            total: parseInt(total),
            files: files.sort((a, b) => {
              const aMatch = a.match(/-(\d+)-/)
              const bMatch = b.match(/-(\d+)-/)
              return aMatch && bMatch ? (parseInt(aMatch[1]) - parseInt(bMatch[1])) : 0
            })
          }
        }

        batchGroupFiles.push(groupName)
      }
      // 排序文件列表
      const sortedFiles = [...batchGroupFiles, ...statFiles].sort((a, b) => {
        const aInfo = fileInfo[a], bInfo = fileInfo[b]
        return aInfo.isGroup !== bInfo.isGroup
          ? (aInfo.isGroup ? -1 : 1)
          : (bInfo.timestamp - aInfo.timestamp)
      })

      return { files: sortedFiles, fileInfo }
    } catch (e) {
      ctx.logger.error(e.message)
      return { files: [], fileInfo: {} }
    }
  },

  // 从文件导入统计数据
  async importFromFile(ctx: Context, filename: string, overwrite = false) {
    const dataDir = getStatDirectory()
    let files = []

    try {
      // 处理不同类型的文件名
      if (/^\d+-\d+$/.test(filename)) {
        const [groupIdx, fileIdx] = filename.split('-').map(Number)
        const { files: filesList, fileInfo } = await this.listImportFiles(ctx)

        if (groupIdx < 1 || groupIdx > filesList.length || !filesList[groupIdx-1].includes('(N=') ||
            !fileInfo[filesList[groupIdx-1]]?.batchInfo?.files ||
            fileIdx < 1 || fileIdx > fileInfo[filesList[groupIdx-1]]?.batchInfo?.files.length) {
          throw new Error(`文件序号无效`)
        }

        const groupName = filesList[groupIdx-1]
        const targetFile = fileInfo[groupName].batchInfo.files[fileIdx-1]
        const targetPath = path.join(dataDir, targetFile)
        if (fs.existsSync(targetPath)) {
          files.push(targetFile)
        }
      }
      else if (filename.includes('(N=')) {
        const match = filename.match(/(.*)\(N=(\d+)\)$/)
        // 收集批次文件
        const [, baseFilename, totalBatches] = match
        for (let i = 1; i <= parseInt(totalBatches); i++) {
          const batchFile = `${baseFilename}-${i}-${totalBatches}.json`
          const batchPath = path.join(dataDir, batchFile)
          if (fs.existsSync(batchPath)) {
            files.push(batchFile)
          }
        }
      }
      else {
        // 单个文件
        const fileToCheck = filename.endsWith('.json') ? filename : `${filename}.json`
        const filePath = path.join(dataDir, fileToCheck)
        if (fs.existsSync(filePath)) {
          files.push(fileToCheck)
        }
      }
      // 清除现有数据
      if (overwrite) {
        await ctx.database.remove('analytics.stat', {})
      }
      // 导入处理
      let totalStats = { imported: 0, errors: 0, invalidRecords: 0 }
      for (let i = 0; i < files.length; i++) {
        const content = await fs.promises.readFile(path.join(dataDir, files[i]), 'utf-8')

        const { validRecords, invalidRecords } = this.parseJSON(content)
        const result = await this.importRecords(ctx, validRecords)

        totalStats.imported += result.imported
        totalStats.errors += result.errors
        totalStats.invalidRecords += invalidRecords
      }

      const totalAttempted = totalStats.imported + totalStats.errors

      return files.length === 1
        ? `导入成功（${totalStats.imported}/${totalAttempted}条）`
        : `批量导入成功（${totalStats.imported}/${totalAttempted}条）`
    } catch (e) {
      throw new Error(e.message)
    }
  },

  // 导入历史数据
  async importLegacyData(ctx: Context, overwrite = false) {
    if (!ctx.database.tables['analytics.command']) {
      throw new Error('无历史数据表，请安装 analytics 插件')
    }

    const [records, bindings] = await Promise.all([
      ctx.database.get('analytics.command', {}),
      ctx.database.get('binding', {})
    ])

    if (!records.length) throw new Error('历史数据为空')

    if (overwrite) {
      await ctx.database.remove('analytics.stat', {})
    }
    // 用户ID映射
    const userIdMap = new Map(
      bindings.filter(b => b.aid)
        .map(b => [b.aid.toString(), { pid: b.pid, platform: b.platform }])
    )
    // 合并记录
    const mergedRecords = new Map()

    records.forEach(cmd => {
      const binding = userIdMap.get(cmd.userId?.toString())
      if (!binding || !cmd.channelId) return

      const commandValue = cmd.name || '_message'
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

    const result = await this.importRecords(ctx, Array.from(mergedRecords.values()))
    const totalAttempted = result.imported + result.errors
    return `导入成功（${result.imported}/${totalAttempted}条）`
  },

  // 解析JSON数据
  parseJSON(content: string) {
    try {
      const data = JSON.parse(content)

      let invalidRecords = 0
      const validRecords = []

      for (const record of data) {
        if (!record.platform || !record.guildId || !record.userId || !record.command) {
          invalidRecords++
          continue
        }

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
      throw new Error(error.message)
    }
  },

  // 导入记录到数据库
  async importRecords(ctx: Context, records: StatRecord[]) {
    let imported = 0, errors = 0
    const batchSize = 100

    const processName = (name: string, id: string): string => {
      if (!name) return '';
      const cleanName = utils.sanitizeString(name);
      if (!cleanName || /^[\s*□]+$/.test(cleanName)) return '';
      if (id && (cleanName === id || cleanName.includes(id))) return '';
      return cleanName;
    };
    // 分批处理
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize)

      await Promise.all(batch.map(async record => {
        const query = {
          platform: record.platform,
          guildId: record.guildId,
          userId: record.userId,
          command: record.command
        }

        try {
          const [existing] = await ctx.database.get('analytics.stat', query)

          if (existing) {
            // 更新现有记录
            const existingUserName = existing.userName?.trim() || '';
            const recordUserName = processName(record.userName, record.userId);
            const newUserName = existingUserName && recordUserName
              ? (record.lastTime > existing.lastTime ? recordUserName : existingUserName)
              : (existingUserName || recordUserName);

            const existingGuildName = existing.guildName?.trim() || '';
            const recordGuildName = processName(record.guildName, record.guildId);
            const newGuildName = existingGuildName && recordGuildName
              ? (record.lastTime > existing.lastTime ? recordGuildName : existingGuildName)
              : (existingGuildName || recordGuildName);

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
          errors++
        }
      }))
    }

    return { imported, errors }
  }
}