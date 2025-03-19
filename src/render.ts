import { Context } from 'koishi'
import {} from 'koishi-plugin-puppeteer'
import { StatProcessOptions } from './utils'
import { StatRecord } from './index'
import { utils } from './utils'

/**
 * 将HTML内容转换为图片
 * @param {string} html - 要渲染的HTML内容
 * @param {Context} ctx - Koishi上下文
 * @param {Object} options - 渲染选项
 * @param {number} [options.width] - 图片宽度
 * @returns {Promise<Buffer>} 图片Buffer数据
 */
export async function htmlToImage(html: string, ctx: Context, options: { width?: number } = {}): Promise<Buffer> {
  try {
    const page = await ctx.puppeteer.page()
    // 设置初始视口大小，默认使用720px
    const viewportWidth = options.width || 720
    await page.setViewport({
      width: viewportWidth,
      height: 1080,
      deviceScaleFactor: 2.0
    })
    // 设置HTML内容
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body {
              margin: 0;
              padding: 0;
              font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
              background: white;
            }
          </style>
        </head>
        <body>${html}</body>
      </html>
    `, { waitUntil: 'networkidle0' })
    // 计算实际内容高度
    const contentHeight = await page.evaluate(() => {
      return document.body.scrollHeight;
    });
    // 调整视口高度
    await page.setViewport({
      width: viewportWidth,
      height: contentHeight,
      deviceScaleFactor: 2.0
    });
    // 等待所有图片加载完成
    await page.evaluate(() => {
      const imgPromises = Array.from(document.querySelectorAll('img'))
        .map(img => img.complete ? Promise.resolve() :
             new Promise(resolve => {
               img.addEventListener('load', resolve);
               img.addEventListener('error', resolve);
             })
        );
      return Promise.all(imgPromises);
    });
    // 截取整个页面
    const imageBuffer = await page.screenshot({
      type: 'png',
      fullPage: true,
      omitBackground: true
    });

    await page.close();
    return imageBuffer;
  } catch (error) {
    ctx.logger.error('图片渲染出错:', error)
    throw new Error('图片渲染出错')
  }
}

/**
 * 将统计记录转换为图表数据
 * @param {StatRecord[]} records - 统计记录数组
 * @param {keyof StatRecord} key - 统计键名
 * @param {StatProcessOptions} options - 处理选项
 * @returns {Array<{name: string, value: number, time: string}>} 转换后的图表数据
 */
export function recordsToChartData(records: StatRecord[], key: keyof StatRecord, options: StatProcessOptions = {}): Array<{name: string, value: number, time: string}> {
  const {
    sortBy = 'count',
    disableCommandMerge = false,
    truncateId = false,
    displayBlacklist = [],
    displayWhitelist = []
  } = options;

  // 处理数据聚合
  const keyFormatter = (key === 'command' && !disableCommandMerge)
    ? (k: string) => k?.split('.')[0] || '' : undefined;

  const dataMap = new Map<string, {count: number, lastTime: Date, displayName?: string}>();
  // 过滤记录
  const filteredRecords = (key === 'command' && !disableCommandMerge)
    ? records.filter(r => r.command !== '_message') : records;
  // 聚合记录
  for (const record of filteredRecords) {
    const recordKey = record[key] as string;
    if (displayWhitelist.length && !displayWhitelist.some(p => recordKey.includes(p))) {
      continue;
    }
    if (displayBlacklist.length && displayBlacklist.some(p => recordKey.includes(p))) {
      continue;
    }

    const formattedKey = keyFormatter ? keyFormatter(recordKey) : recordKey;
    let displayName = formattedKey;

    if (key === 'userId' && record.userName) {
      displayName = truncateId ? record.userName : `${record.userName} (${recordKey})`;
    } else if (key === 'guildId' && record.guildName) {
      displayName = truncateId ? record.guildName : `${record.guildName} (${recordKey})`;
    }

    const current = dataMap.get(formattedKey) || { count: 0, lastTime: record.lastTime, displayName };
    current.count += record.count;
    if (record.lastTime > current.lastTime) {
      current.lastTime = record.lastTime;
    }
    dataMap.set(formattedKey, current);
  }
  // 转换为数组
  let chartData = Array.from(dataMap.entries()).map(([key, data]) => ({
    name: data.displayName || key,
    value: data.count,
    time: utils.formatTimeAgo(data.lastTime)
  }));
  // 排序
  chartData.sort((a, b) => sortBy === 'count' ? b.value - a.value : a.name.localeCompare(b.name));

  return chartData;
}

/**
 * 生成统计数据的图片
 * @param {Context} ctx - Koishi上下文
 * @param {StatRecord[]} records - 统计记录数组
 * @param {keyof StatRecord} key - 统计键名
 * @param {string} title - 图表标题
 * @param {StatProcessOptions} options - 处理选项
 * @returns {Promise<Buffer>} 生成的图片Buffer
 */
export async function generateStatImage(
  ctx: Context,
  records: StatRecord[],
  key: keyof StatRecord,
  title: string,
  options: StatProcessOptions = {}
): Promise<Buffer> {
  // 转换记录为图表数据
  const chartData = recordsToChartData(records, key, {
    ...options,
    displayWhitelist: [],
    displayBlacklist: []
  });
  // 设置颜色主题
  const headerColor = key === 'userId' ? '#ff6b81' : (key === 'guildId' ? '#5dd5a8' : '#4d7cfe');
  // 当前时间
  const currentTime = new Date().toLocaleString();
  // 计算总次数和总项目数
  const totalItems = chartData.length;
  const totalCount = chartData.reduce((sum, item) => sum + item.value, 0);
  // 生成统计摘要
  const statsSummary = `
    <div style="display:flex; justify-content:space-between; margin-bottom:12px;">
      <div style="display:flex; gap:10px;">
        <div style="background-color:#f8f9fa; border-radius:4px; padding:4px 8px; font-size:13px;">
          <span style="color:#666;">总项目数：</span>
          <span style="font-weight:bold; color:#333;">${totalItems}</span>
        </div>
        <div style="background-color:#f8f9fa; border-radius:4px; padding:4px 8px; font-size:13px;">
          <span style="color:#666;">总${key === 'command' ? '次数' : '条数'}：</span>
          <span style="font-weight:bold; color:#333;">${totalCount}</span>
        </div>
      </div>
    </div>
  `;
  // 生成HTML内容并渲染
  const html = `
    <div style="padding:15px; max-width:690px; margin:0 auto; box-shadow:0 2px 10px rgba(0,0,0,0.1); border-radius:10px; overflow:hidden;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px; padding-bottom:8px; border-bottom:1px solid #eee;">
        <h2 style="margin:0; color:#333; font-size:18px;">${title}</h2>
        <div style="font-size:12px; color:#888; background-color:#f8f9fa; padding:4px 8px; border-radius:4px;">${currentTime}</div>
      </div>
      ${statsSummary}
      ${generateTableHTML(chartData, key, headerColor)}
    </div>
  `;
  return await htmlToImage(html, ctx);
}

/**
 * 生成综合统计图，将用户的所有统计信息整合到一张图中
 * @param {Context} ctx - Koishi上下文
 * @param {Array<{records: StatRecord[], title: string, key: keyof StatRecord, options?: StatProcessOptions}>} datasets - 多个数据集
 * @param {string} mainTitle - 主标题
 * @param {Object} summaryData - 汇总数据
 * @returns {Promise<Buffer>} 生成的图片Buffer
 */
export async function generateCombinedStatImage(
  ctx: Context,
  datasets: Array<{records: StatRecord[], title: string, key: keyof StatRecord, options?: StatProcessOptions}>,
  mainTitle: string,
  summaryData: {label: string, value: string|number}[]
): Promise<Buffer> {
  // 处理数据集
  const tablesHTML = datasets.map(dataset => {
    if (!dataset.records.length) return '';
    const chartData = recordsToChartData(dataset.records, dataset.key, {
      ...dataset.options,
      displayWhitelist: [],
      displayBlacklist: []
    });

    const headerColor = dataset.key === 'command' ? '#4d7cfe' :
                       (dataset.key === 'guildId' ? '#5dd5a8' : '#ff6b81');
    // 计算总次数和总项目数
    const totalItems = chartData.length;
    const totalCount = chartData.reduce((sum, item) => sum + item.value, 0);
    // 生成统计摘要
    const datasetSummary = `
      <div style="display:flex; justify-content:space-between; margin-bottom:8px; margin-top:4px;">
        <div style="display:flex; gap:10px;">
          <div style="background-color:#f8f9fa; border-radius:4px; padding:3px 6px; font-size:12px;">
            <span style="color:#666;">项目数：</span>
            <span style="font-weight:bold; color:#333;">${totalItems}</span>
          </div>
          <div style="background-color:#f8f9fa; border-radius:4px; padding:3px 6px; font-size:12px;">
            <span style="color:#666;">总${dataset.key === 'command' ? '次数' : '条数'}：</span>
            <span style="font-weight:bold; color:#333;">${totalCount}</span>
          </div>
        </div>
      </div>
    `;

    return `
      <div style="margin-bottom:20px;">
        <h3 style="margin:12px 0; color:#333; font-size:16px;">${dataset.title}</h3>
        ${datasetSummary}
        ${generateTableHTML(chartData, dataset.key, headerColor)}
      </div>
    `;
  }).join('');
  // 生成汇总卡片
  const summaryHTML = `
    <div style="text-align:center; margin-bottom:25px;">
      ${summaryData.map(item => `
        <div style="display:inline-block; background-color:#f8f9fa; border-radius:8px; padding:10px 15px; margin:6px; min-width:120px; box-shadow:0 1px 3px rgba(0,0,0,0.05);">
          <div style="font-size:13px; color:#666; margin-bottom:4px;">${item.label}</div>
          <div style="font-size:18px; font-weight:bold; color:#333;">${item.value}</div>
        </div>
      `).join('')}
    </div>
  `;
  // 当前时间
  const currentTime = new Date().toLocaleString();
  // 组合所有内容
  const html = `
    <div style="padding:20px; max-width:680px; margin:0 auto; box-shadow:0 2px 12px rgba(0,0,0,0.12); border-radius:10px; overflow:hidden;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; padding-bottom:12px; border-bottom:1px solid #eee;">
        <h2 style="margin:0; color:#333; font-size:18px;">${mainTitle}</h2>
        <div style="font-size:12px; color:#888; background-color:#f8f9fa; padding:4px 8px; border-radius:4px;">${currentTime}</div>
      </div>
      ${summaryHTML}
      ${tablesHTML}
    </div>
  `;
  return await htmlToImage(html, ctx);
}

/**
 * 生成表格HTML (内部函数)
 * @param {Array<{name: string, value: number, time: string}>} data - 表格数据
 * @param {keyof StatRecord} key - 数据类型
 * @param {string} headerColor - 表头颜色
 * @returns {string} 表格HTML
 */
function generateTableHTML(data: Array<{name: string, value: number, time: string}>, key: keyof StatRecord, headerColor: string = '#4d7cfe'): string {
  // 计算总值用于百分比
  const totalValue = data.reduce((sum, item) => sum + item.value, 0);
  // 生成表格行HTML
  const generateRows = (items) => {
    return items.map(item => {
      const valueText = key === 'command' ? `${item.value}次` : `${item.value}条`;
      const percentValue = (item.value / totalValue) * 100;
      const percentText = `${percentValue.toFixed(2)}%`;

      return `
        <tr>
          <td style="padding:6px 8px; border-bottom:1px solid #eee;">${item.name}</td>
          <td style="padding:6px 8px; border-bottom:1px solid #eee; text-align:right; width:60px;">${valueText}</td>
          <td style="padding:6px 8px; border-bottom:1px solid #eee; text-align:right; width:70px; font-family:monospace;">${percentText}</td>
          <td style="padding:6px 8px; border-bottom:1px solid #eee; text-align:right; width:90px; color:#666;">${item.time}</td>
        </tr>
      `;
    }).join('');
  };
  return `
    <div style="overflow:hidden; border-radius:8px; box-shadow:0 1px 6px rgba(0,0,0,0.05);">
      <table style="width:100%; border-collapse:collapse; background:white;">
        <thead>
          <tr style="background-color:${headerColor};">
            <th style="padding:8px; text-align:left; color:white; font-weight:500;">名称</th>
            <th style="padding:8px; text-align:right; width:60px; color:white; font-weight:500;">数值</th>
            <th style="padding:8px; text-align:right; width:70px; color:white; font-weight:500;">占比</th>
            <th style="padding:8px; text-align:right; width:90px; color:white; font-weight:500;">最后活动</th>
          </tr>
        </thead>
        <tbody>
          ${generateRows(data)}
        </tbody>
      </table>
    </div>
  `;
}
