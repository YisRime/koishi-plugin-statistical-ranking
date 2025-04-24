import * as fs from 'fs'
import * as path from 'path'

/**
 * 通用工具函数集合
 * 提供字符串处理、时间格式化、文件操作等基础功能
 */
export const Utils = {
  /**
   * 获取字符串显示宽度（中文字符计为2，其他字符计为1）
   * @param {string} str - 输入字符串
   * @returns {number} 字符串显示宽度
   */
  getStringDisplayWidth(str: string): number {
    if (!str) return 0
    return Array.from(str).reduce((w, c) =>
      w + (/[\u3000-\u9fff\uff01-\uff60\u2E80-\u2FDF\u3040-\u30FF\u2600-\u26FF\u2700-\u27BF]/.test(c) ? 2 : 1), 0)
  },

  /**
   * 按显示宽度截断字符串
   * @param {string} str - 输入字符串
   * @param {number} maxWidth - 最大显示宽度
   * @returns {string} 截断后的字符串
   */
  truncateByDisplayWidth(str: string, maxWidth: number): string {
    if (!str) return str
    let width = 0, result = ''
    for (const char of Array.from(str)) {
      const charWidth = /[\u3000-\u9fff\uff01-\uff60\u2E80-\u2FDF\u3040-\u30FF\u2600-\u26FF\u2700-\u27BF]/.test(char) ? 2 : 1
      if (width + charWidth > maxWidth) break
      width += charWidth
      result += char
    }
    return result
  },

  /**
   * 清理字符串，移除不可见字符和特殊字符，限制长度
   * @param {string} input - 输入字符串
   * @returns {string} 清理后的字符串
   */
  sanitizeString(input: string): string {
    if (input == null) return ''
    return String(input)
      // 移除控制字符和零宽字符
      .replace(/[\x00-\x1F\x7F\u200B-\u200F\u2028-\u202F\uFEFF]/g, '')
      // 简化连续重复的字符
      .replace(/(.)\1{5,}/g, '$1$1$1…')
      // 替换可能导致数据库问题的字符
      .replace(/[<>`$()[\]{};'"\\\=]/g, '')
      .replace(/\s+/g, ' ').trim()
      .slice(0, 64)
  },

  /**
   * 格式化时间为"多久前"的形式
   * @param {Date} date - 日期对象
   * @returns {string} 格式化后的时间字符串
   */
  formatTimeAgo(date: Date): string {
    if (!date?.getTime?.()) return '未知时间'
    const diff = Date.now() - date.getTime()
    if (Math.abs(diff) < 3000) return (diff < 0 ? '一会后' : '一会前')
    const units: [number, string][] = [
      [31536000000, '年'],
      [2592000000, '月'],
      [86400000, '天'],
      [3600000, '时'],
      [60000, '分'],
      [1000, '秒']
    ]
    const absDiff = Math.abs(diff)
    const suffix = diff < 0 ? '后' : '前'
    for (let i = 0; i < units.length; i++) {
      const [primaryDiv, primaryUnit] = units[i]
      if (absDiff < primaryDiv) continue
      const primaryVal = Math.floor(absDiff / primaryDiv)
      if (i < units.length - 1) {
        const [secondaryDiv, secondaryUnit] = units[i + 1]
        const remainder = absDiff % primaryDiv
        const secondaryVal = Math.floor(remainder / secondaryDiv)
        if (secondaryVal > 0) {
          return `${primaryVal}${primaryUnit}${secondaryVal}${secondaryUnit}${suffix}`
        }
      }
      return `${primaryVal}${primaryUnit}${suffix}`
    }
    return `一会${suffix}`
  },

  /**
   * 格式化日期时间为年月日和24小时制
   * @param {Date} date - 日期对象
   * @returns {string} 格式化后的日期时间字符串
   */
  formatDateTime(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  },

  /**
   * 获取数据目录
   * @param {string} [subdir='statistical-ranking'] 子目录名称
   * @returns {string} 数据目录的绝对路径
   */
  getDataDirectory(subdir: string = 'statistical-ranking'): string {
    const dataDir = path.join(process.cwd(), 'data', subdir)
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }
    return dataDir
  },

  /**
   * 获取平台用户ID，尝试从绑定数据中查找
   * @param {any} session - 会话对象
   * @returns {Promise<string>} 平台用户ID
   */
  async getPlatformId(session: any): Promise<string> {
    if (!session?.userId || !session?.platform || !session?.app?.database) return session?.userId || ''
    try {
      const [binding] = await session.app.database.get('binding', {
        aid: session.userId,
        platform: session.platform
      })
      return binding?.pid || session.userId
    } catch {
      return session.userId || ''
    }
  },

  /**
   * 获取会话信息，包括平台、群组、用户等信息
   * @param {any} session - 会话对象
   * @returns {Promise<{platform: string, guildId: string, userId: string, userName: string, guildName: string} | null>}
   * 会话信息对象，获取失败时返回null
   */
  async getSessionInfo(session: any) {
    if (!session) return null
    const platform = session.platform
    const guildId = session.guildId || session.groupId || session.channelId || 'private'
    const userId = await this.getPlatformId(session)
    const bot = session.bot
    let userName = '', guildName = ''
    userName = session.username ?? ''
    if (!userName && bot?.getGuildMember) {
      const member = await bot.getGuildMember(guildId, userId).catch(() => null)
      userName = member?.username ?? ''
    }
    if (guildId !== 'private' && bot?.getGuild) {
      const guild = await bot.getGuild(guildId).catch(() => null)
      guildName = guild?.name ?? ''
    }
    return {
      platform,
      guildId,
      userId,
      userName: this.sanitizeString(userName),
      guildName: this.sanitizeString(guildName)
    }
  },

  /**
   * 检查目标是否匹配规则列表中的任何规则
   * @param {string[]} list - 规则列表
   * @param {{platform: string, guildId: string, userId: string, command?: string}} target - 目标对象
   * @returns {boolean} 是否匹配
   */
  matchRuleList(list: string[], target: { platform: string, guildId: string, userId: string, command?: string }): boolean {
    return list.some(rule => {
      if (target.command && rule === target.command) return true
      const [rulePlatform = '', ruleGuild = '', ruleUser = ''] = rule.split(':')
      return (rulePlatform && target.platform === rulePlatform) ||
             (ruleGuild && target.guildId === ruleGuild) ||
             (ruleUser && target.userId === ruleUser) ||
             (rule.endsWith(':') && target.platform && rule.startsWith(target.platform + ':'))
    })
  },

  /**
   * 构建条件描述
   * @param {Object} options - 包含可能的条件的对象
   * @returns {string[]} 条件描述数组
   */
  buildConditions(options: {
    user?: string, guild?: string, platform?: string, command?: string
  }): string[] {
    return Object.entries({
      user: ['用户', options.user],
      guild: ['群组', options.guild],
      platform: ['平台', options.platform],
      command: ['命令', options.command]
    }).filter(([_, [__, value]]) => value).map(([_, [label, value]]) => `${label}${value}`)
  },

  /**
   * 标准化统计记录
   * @param {any} record 待处理的记录
   * @param {Object} options 选项
   * @returns {any} 标准化后的记录
   */
  normalizeRecord(record: any, options: { sanitizeNames?: boolean } = {}): any {
    const result = { ...record };
    if (options.sanitizeNames) {
      if (result.userName) {
        result.userName = this.sanitizeString(result.userName);
      }
      if (result.guildName) {
        result.guildName = this.sanitizeString(result.guildName);
      }
    }
    // 确保时间字段是Date对象
    if (result.lastTime && !(result.lastTime instanceof Date)) {
      result.lastTime = new Date(result.lastTime);
    }
    // 确保计数是数字
    if (result.count && typeof result.count !== 'number') {
      result.count = parseInt(String(result.count)) || 1;
    }
    return result;
  },

  /**
   * 生成统计数据映射表
   * @param {Array<any>} records 记录数组
   * @param {string} keyField 用作键的字段名
   * @param {function} [keyFormatter] 键格式化函数
   * @returns {Map<string, {count: number, lastTime: Date, displayName?: string}>}
   */
  generateStatsMap(records: any[], keyField: string, keyFormatter?: (key: string) => string): Map<string, any> {
    const dataMap = new Map<string, {count: number, lastTime: Date, displayName?: string}>();
    records.forEach(record => {
      const recordKey = record[keyField];
      if (!recordKey) return;
      const formattedKey = keyFormatter ? keyFormatter(recordKey) : recordKey;
      let displayName = formattedKey;
      if (keyField === 'userId' && record.userName) {
        displayName = record.userName;
      } else if (keyField === 'guildId' && record.guildName) {
        displayName = record.guildName;
      }
      const current = dataMap.get(formattedKey) || {
        count: 0,
        lastTime: record.lastTime,
        displayName
      };
      current.count += record.count;
      if (record.lastTime > current.lastTime) {
        current.lastTime = record.lastTime;
      }
      dataMap.set(formattedKey, current);
    });
    return dataMap;
  },

  /**
   * 过滤统计记录
   * @param {Array<any>} records 记录数组
   * @param {Object} options 过滤选项
   * @returns {Array<any>} 过滤后的记录
   */
  filterStatRecords(records: any[], options: {
    keyField?: string,
    displayWhitelist?: string[],
    displayBlacklist?: string[],
    disableCommandMerge?: boolean
  } = {}): any[] {
    const {
      keyField = 'command',
      displayWhitelist = [],
      displayBlacklist = [],
      disableCommandMerge = false
    } = options;
    let filteredRecords = records;
    // 按命令类型过滤
    if (keyField === 'command' && !disableCommandMerge) {
      filteredRecords = records.filter(r => r.command !== '_message');
    }
    // 应用白名单和黑名单
    if (displayWhitelist.length || displayBlacklist.length) {
      filteredRecords = filteredRecords.filter(record => {
        const key = record[keyField];
        if (!key) return false;
        // 白名单优先
        if (displayWhitelist.length) {
          return displayWhitelist.some(pattern => key.includes(pattern));
        }
        // 黑名单过滤
        return !displayBlacklist.some(pattern => key.includes(pattern));
      });
    }
    return filteredRecords;
  },

  /**
   * 通用数据排序函数
   * @param {Array<any>} data 数据数组
   * @param {string} sortBy 排序字段: 'count' | 'key' | 'time'
   * @param {string} keyField 键字段名
   * @returns {Array<any>} 排序后的数组
   */
  sortData(data: any[], sortBy: string = 'count', keyField: string = 'key'): any[] {
    return [...data].sort((a, b) => {
      if (sortBy === 'count') return b.count - a.count;
      if (sortBy === 'time' && a.lastTime && b.lastTime) {
        return new Date(b.lastTime).getTime() - new Date(a.lastTime).getTime();
      }
      return a[keyField].localeCompare(b[keyField]);
    });
  },

  /**
   * 处理名称显示
   * @param {string} name 原始名称
   * @param {string} id ID标识
   * @param {boolean} truncateId 是否截断ID
   * @returns {string} 格式化后的名称
   */
  formatDisplayName(name: string, id: string, truncateId: boolean = false): string {
    if (!name) return id || '';
    const cleanName = this.sanitizeString(name);
    if (!cleanName || /^[\s*□]+$/.test(cleanName)) return id || '';
    if (truncateId || cleanName === id || cleanName.includes(id)) return cleanName
    return `${cleanName} (${id})`;
  }
}