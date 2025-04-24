import { Context } from 'koishi'
import { StatRecord } from './index'
import { Utils } from './utils'
import * as fs from 'fs'
import * as path from 'path'

/**
 * 统计数据导入导出工具集
 */
export const io = {
  /**
   * 导出统计数据到文件
   * @param {Context} ctx Koishi 上下文
   * @param {string} filename 文件名（不含扩展名）
   * @param {Object} options 导出选项
   * @param {string} [options.userId] 筛选特定用户ID
   * @param {string} [options.platform] 筛选特定平台
   * @param {string} [options.guildId] 筛选特定群组ID
   * @param {string} [options.command] 筛选特定命令
   * @param {number} [options.batchSize] 批处理大小，默认为200条/批
   * @returns {Promise<{count: number, batches: number, files: Array<{count: number, path: string, filename: string, batch: number, totalBatches: number}>}>} 导出结果
   * @throws {Error} 导出失败时抛出错误
   */
  async exportToFile(ctx: Context, filename: string, options: {
    userId?: string, platform?: string, guildId?: string, command?: string, batchSize?: number
  }) {
    const query = Object.fromEntries(
      Object.entries({...options, batchSize: undefined})
        .filter(([_, value]) => Boolean(value))
    );
    const records = await ctx.database.get('analytics.stat', query)
    if (!records.length) throw new Error('历史数据为空')
    const timestamp = new Date().toISOString().replace(/[:T.]/g, '-').substring(0, 19)
    const batchSize = options.batchSize || 200
    const totalRecords = records.length
    const batches = Math.ceil(totalRecords / batchSize)
    const exportFiles = []
    const statDir = Utils.getDataDirectory()
    for (let batch = 0; batch < batches; batch++) {
      const start = batch * batchSize
      const end = Math.min((batch + 1) * batchSize, totalRecords)
      const batchRecords = records.slice(start, end)
      const outputFilename = batches === 1
        ? `${filename}-${timestamp}.json`
        : `${filename}-${timestamp}-${batches}-${batch+1}.json`
      const filePath = path.join(statDir, outputFilename)
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
    }
    return { count: totalRecords, batches, files: exportFiles }
  },

  /**
   * 列出可导入的统计数据文件
   * @param {Context} ctx Koishi 上下文
   * @returns {Promise<{files: string[], fileInfo: Record<string, any>}>} 文件列表和详细信息
   */
  async listImportFiles(ctx: Context) {
    const statDir = Utils.getDataDirectory()
    const files = await fs.promises.readdir(statDir)
    const statFiles = files.filter(file =>
      file.endsWith('.json') && (file.includes('stat') || file.includes('analytics'))
    )
    if (!statFiles.length) return { files: [], fileInfo: {} }
    const fileInfo = {}
    const batchGroups = new Map()
    // 处理文件信息
    for (const file of statFiles) {
      const stats = await fs.promises.stat(path.join(statDir, file))
      const batchMatch = file.match(/(.*)-(\d+)-(\d+)\.json$/)
      const isBatch = !!batchMatch
      fileInfo[file] = {
        mtime: stats.mtime.toLocaleString(),
        timestamp: stats.mtime.getTime(),
        isBatch,
        batchInfo: isBatch ? {
          base: batchMatch[1],
          total: parseInt(batchMatch[2]),
          current: parseInt(batchMatch[3])
        } : undefined
      }
      // 收集批次组
      if (isBatch) {
        const [, base, total, ] = batchMatch
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
      const [, base, total, ] = groupInfo
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
            const aMatch = a.match(/-(\d+)-(\d+)/)
            const bMatch = b.match(/-(\d+)-(\d+)/)
            if (aMatch && bMatch) {
              // 如果总批次相同则按当前批次排序
              if (aMatch[1] === bMatch[1]) {
                return parseInt(aMatch[2]) - parseInt(bMatch[2]);
              }
            }
            return 0;
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
  },

  /**
   * 从文件导入统计数据
   * @param {Context} ctx Koishi 上下文
   * @param {string} filename 文件名或文件组标识
   * @param {boolean} [overwrite=false] 是否覆盖现有数据
   * @returns {Promise<string>} 导入结果消息
   * @throws {Error} 导入失败时抛出错误
   */
  async importFromFile(ctx: Context, filename: string, overwrite = false) {
    const dataDir = Utils.getDataDirectory()
    let files = []
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
        const batchFile = `${baseFilename}-${totalBatches}-${i}.json`
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
  },

  /**
   * 从 analytics 插件导入历史数据
   * @param {Context} ctx Koishi 上下文
   * @param {boolean} [overwrite=false] 是否覆盖现有数据
   * @returns {Promise<string>} 导入结果消息
   * @throws {Error} 导入失败时抛出错误
   */
  async importLegacyData(ctx: Context, overwrite = false) {
    if (!ctx.database.tables['analytics.command']) {throw new Error('无历史数据表')}
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

  /**
   * 解析JSON格式的统计数据
   * @param {string} content JSON格式的字符串内容
   * @returns {{validRecords: Array<StatRecord>, totalRecords: number, invalidRecords: number}} 解析结果，包括有效记录、总记录数和无效记录数
   * @throws {Error} 解析失败时抛出错误
   */
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
        validRecords.push(Utils.normalizeRecord({
          ...rest,
          platform: rest.platform,
          guildId: rest.guildId,
          userId: rest.userId,
          userName: rest.userName ?? '',
          guildName: rest.guildName ?? '',
          command: rest.command,
          count: parseInt(String(rest.count)) || 1,
          lastTime: rest.lastTime ? new Date(rest.lastTime) : new Date()
        }, { sanitizeNames: true }))
      }
      return { validRecords, totalRecords: data.length, invalidRecords }
    } catch (error) {
      throw new Error(error.message)
    }
  },

  /**
   * 将统计记录导入到数据库
   * @param {Context} ctx Koishi 上下文
   * @param {Array<StatRecord>} records 要导入的统计记录数组
   * @returns {Promise<{imported: number, errors: number}>} 导入结果，包括成功导入数和错误数
   */
  async importRecords(ctx: Context, records: StatRecord[]) {
    let imported = 0, errors = 0
    const batchSize = 100
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
            const recordUserName = Utils.sanitizeString(record.userName || '');
            const newUserName = existingUserName && recordUserName
              ? (record.lastTime > existing.lastTime ? recordUserName : existingUserName)
              : (existingUserName || recordUserName);
            const existingGuildName = existing.guildName?.trim() || '';
            const recordGuildName = Utils.sanitizeString(record.guildName || '');
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
              userName: Utils.sanitizeString(record.userName || ''),
              guildName: Utils.sanitizeString(record.guildName || '')
            })
          }
          imported++
        } catch (e) {
          errors++
        }
      }))
    }
    return { imported, errors }
  },

  /**
   * 注册导入导出命令
   * @param {Context} ctx Koishi 上下文
   * @param {any} parent 父命令对象
   */
  registerCommands(ctx: Context, parent: any) {
    parent.subcommand('.export', '导出统计数据', { authority: 4 })
      .option('user', '-u [user:string] 指定用户')
      .option('platform', '-p [platform:string] 指定平台')
      .option('guild', '-g [guild:string] 指定群组')
      .option('command', '-c [command:string] 指定命令')
      .action(async ({ options, session }) => {
        try {
          // 发送进度提示
          if (Object.values(options).some(Boolean)) {
            await session.send('正在导出...')
          }
          // 执行导出
          const result = await this.exportToFile(ctx, 'stat', {
            userId: options.user,
            platform: options.platform,
            guildId: options.guild,
            command: options.command
          })
          // 返回导出结果消息
          if (result.batches === 1) {
            return `导出成功（${result.count}条）：\n- ${result.files[0].filename}`
          } else {
            const fileList = result.files.map(f => `- ${f.filename}`).join('\n')
            return `导出成功（${result.count}条）：\n${fileList}`
          }
        } catch (e) {
          return `导出失败：${e.message}`
        }
      })
    parent.subcommand('.import [selector:number]', '导入统计数据', { authority: 4 })
      .option('force', '-f 覆盖现有数据')
      .option('database', '-d 从历史数据库导入')
      .action(async ({ session, options, args }) => {
        try {
          // 从历史数据库导入
          if (options.database) {
            session.send('正在导入历史记录...')
            try {
              return await this.importLegacyData(ctx, options.force)
            } catch (e) {
              return e.message
            }
          }
          // 获取可导入文件列表
          const { files, fileInfo } = await this.listImportFiles(ctx)
          if (!files.length) {
            return '未找到历史记录文件'
          }
          // 使用序号选择文件导入
          const selector = args[0]
          if (selector) {
            if (selector > 0 && selector <= files.length) {
              const targetFile = files[selector - 1]
              await session.send(`正在${options.force ? '覆盖' : ''}导入文件：\n- ${targetFile}`)
              return await this.importFromFile(ctx, targetFile, options.force)
            }
            return '请输入正确的序号'
          }
          // 显示文件列表
          const fileList = files.map((file, index) => {
            const info = fileInfo[file] || {}
            let prefix = '📄'
            if (file.includes('(N=')) {
              prefix = '📦'
            } else if (info.isBatch) {
              prefix = '📎'
            }
            return `${index + 1}.${prefix}${file}`
          }).join('\n')
          return `使用 import [序号]导入对应文件：\n${fileList}`
        } catch (e) {
          return `导入失败：${e.message}`
        }
      })
  }
}