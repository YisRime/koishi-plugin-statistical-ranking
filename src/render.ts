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
 * @param {number} [options.height] - 图片高度
 * @returns {Promise<Buffer>} 图片Buffer数据
 */
export async function htmlToImage(html: string, ctx: Context, options: { width?: number; height?: number } = {}): Promise<Buffer> {
  try {
    const page = await ctx.puppeteer.page()

    // 设置视口大小
    const viewportWidth = options.width || 1920
    const viewportHeight = options.height || 1080

    await page.setViewport({
      width: viewportWidth,
      height: viewportHeight,
      deviceScaleFactor: 2.0
    })

    // 设置简化的HTML内容
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
              overflow: hidden;
            }
          </style>
        </head>
        <body>
          ${html}
        </body>
      </html>
    `, { waitUntil: 'networkidle0' })

    // 等待图片加载完成
    await page.evaluate(() => {
      return Promise.all(
        Array.from(document.querySelectorAll('img'))
          .map(img => {
            if (img.complete) return Promise.resolve();
            return new Promise(resolve => {
              img.addEventListener('load', resolve);
              img.addEventListener('error', resolve);
            });
          })
      );
    });

    // 截取整个页面作为图片
    const imageBuffer = await page.screenshot({
      type: 'png',
      fullPage: false
    })

    await page.close()
    return imageBuffer

  } catch (error) {
    ctx.logger.error('图片渲染出错:', error)
    throw new Error('生成图片时遇到问题，请稍后重试')
  }
}

/**
 * 生成统计图表的HTML
 * @param {string} title - 图表标题
 * @param {Array<{name: string, value: number, time: string}>} data - 统计数据
 * @param {Object} options - 图表选项
 * @returns {string} 生成的HTML内容
 */
export function generateStatChartHtml(title: string, data: Array<{name: string, value: number, time: string}>, key: string, options: {
  width?: number;
  height?: number;
  barColor?: string;
  titleColor?: string;
  textColor?: string;
} = {}): string {
  const {
    width = 800,
    barColor = '#4d7cfe',
    titleColor = '#333333'
  } = options;

  // 计算最大值以调整图表比例
  const maxValue = Math.max(...data.map(item => item.value), 1);
  const barItems = data.map((item, index) => {
    const percentage = (item.value / maxValue) * 70; // 70%为最大宽度
    const valueText = key === 'command' ? `${item.value}次` : `${item.value}条`;

    return `
      <div class="stat-item">
        <div class="item-info">
          <div class="item-name" title="${item.name}">${item.name}</div>
          <div class="item-value">${valueText}</div>
          <div class="item-time">${item.time}</div>
        </div>
        <div class="bar-container">
          <div class="bar" style="width:${percentage}%"></div>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="stat-chart">
      <style>
        .stat-chart {
          font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
          background-color: white;
          border-radius: 12px;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
          padding: 24px;
          box-sizing: border-box;
          width: ${width}px;
        }
        .chart-title {
          font-size: 22px;
          font-weight: bold;
          color: ${titleColor};
          margin-bottom: 24px;
          text-align: center;
          padding-bottom: 12px;
          border-bottom: 1px solid #eaeaea;
        }
        .stat-items {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .stat-item {
          display: flex;
          flex-direction: column;
          padding: 10px 14px;
          border-radius: 8px;
          background-color: #f8f9fc;
          transition: transform 0.2s ease, box-shadow 0.2s ease;
        }
        .stat-item:hover {
          transform: translateY(-2px);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
        }
        .item-info {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
        }
        .item-name {
          font-size: 15px;
          color: #333;
          flex: 1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .item-value {
          font-size: 15px;
          font-weight: bold;
          color: #333;
          margin: 0 12px;
          min-width: 60px;
          text-align: right;
        }
        .item-time {
          font-size: 13px;
          color: #999;
          margin-left: auto;
          min-width: 80px;
          text-align: right;
        }
        .bar-container {
          width: 100%;
          height: 8px;
          background-color: #e9ecef;
          border-radius: 4px;
          overflow: hidden;
        }
        .bar {
          height: 100%;
          background-color: ${barColor};
          border-radius: 4px;
          transition: width 0.5s ease;
        }
      </style>
      <div class="chart-title">${title}</div>
      <div class="stat-items">
        ${barItems}
      </div>
    </div>
  `;
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

  // 使用相同的StatMap逻辑处理数据聚合
  const keyFormatter = (key === 'command' && !disableCommandMerge)
    ? (k: string) => k?.split('.')[0] || '' : undefined;

  const dataMap = new Map<string, {count: number, lastTime: Date, displayName?: string}>();

  // 过滤记录
  const filteredRecords = (key === 'command' && !disableCommandMerge)
    ? records.filter(r => r.command !== '_message') : records;

  // 聚合记录
  for (const record of filteredRecords) {
    const recordKey = record[key] as string;

    // 过滤黑名单/白名单
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

  // 转换为数组并排序
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
 * 生成统计表格HTML
 * @param {string} title - 表格标题
 * @param {Array<string[]>} rows - 表格行数据
 * @param {string[]} headers - 表格头部
 * @param {Object} options - 表格选项
 * @returns {string} 生成的表格HTML
 */
export function generateStatTableHtml(title: string, rows: Array<string[]>, headers: string[] = [], options: {
  width?: number;
  height?: number;
  headerBgColor?: string;
  stripedColor?: string;
} = {}): string {
  const {
    width = 800,
    height = 600,
    headerBgColor = '#4d7cfe',
    stripedColor = '#f2f5fc'
  } = options;

  const headerHTML = headers.length
    ? `<tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>`
    : '';

  const rowsHTML = rows.map((row, idx) =>
    `<tr class="${idx % 2 === 0 ? 'even' : 'odd'}">${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`
  ).join('');

  return `
    <div class="stat-table-container" style="width:${width}px; max-height:${height}px;">
      <style>
        .stat-table-container {
          font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
          background-color: white;
          border-radius: 10px;
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
          padding: 20px;
          box-sizing: border-box;
          overflow: hidden;
        }
        .table-title {
          font-size: 20px;
          font-weight: bold;
          color: #333;
          margin-bottom: 20px;
          text-align: center;
        }
        table.stat-table {
          width: 100%;
          border-collapse: collapse;
          table-layout: fixed;
        }
        table.stat-table th {
          background-color: ${headerBgColor};
          color: white;
          font-weight: normal;
          padding: 10px;
          text-align: left;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        table.stat-table tr.odd {
          background-color: ${stripedColor};
        }
        table.stat-table td {
          padding: 10px;
          border-bottom: 1px solid #eee;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
      </style>
      <div class="table-title">${title}</div>
      <table class="stat-table">
        <thead>
          ${headerHTML}
        </thead>
        <tbody>
          ${rowsHTML}
        </tbody>
      </table>
    </div>
  `;
}

/**
 * 生成统计卡片HTML
 * @param {string} title - 卡片标题
 * @param {Array<{label: string, value: string|number}>} items - 卡片项目数据
 * @param {Object} options - 卡片选项
 * @returns {string} 生成的卡片HTML
 */
export function generateStatCardHtml(title: string, items: Array<{label: string, value: string|number}>, options: {
  width?: number;
  accent?: string;
  bgColor?: string;
} = {}): string {
  const {
    width = 400,
    accent = '#4d7cfe',
    bgColor = '#ffffff'
  } = options;

  const itemsHTML = items.map(item => `
    <div class="card-item">
      <div class="item-label">${item.label}</div>
      <div class="item-value">${item.value}</div>
    </div>
  `).join('');

  return `
    <div class="stat-card" style="width:${width}px;">
      <style>
        .stat-card {
          font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
          background-color: ${bgColor};
          border-radius: 10px;
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
          padding: 20px;
          box-sizing: border-box;
        }
        .card-title {
          font-size: 18px;
          font-weight: bold;
          color: #333;
          padding-bottom: 10px;
          border-bottom: 2px solid ${accent};
          margin-bottom: 15px;
        }
        .card-items {
          display: flex;
          flex-direction: column;
          gap: 15px;
        }
        .card-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .item-label {
          font-size: 14px;
          color: #666;
        }
        .item-value {
          font-size: 16px;
          font-weight: bold;
          color: #333;
        }
      </style>
      <div class="card-title">${title}</div>
      <div class="card-items">
        ${itemsHTML}
      </div>
    </div>
  `;
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
  // 转换记录为图表数据，不限制数量以显示全部数据
  const chartData = recordsToChartData(records, key, options);

  // 根据数据量动态调整高度
  // 基础高度 + 每个数据项高度 + 边距
  const baseHeight = 200;  // 标题和边距的基础高度
  const itemHeight = 60;   // 每个数据项的高度
  const height = baseHeight + chartData.length * itemHeight;

  // 调整宽度以适应内容
  const width = 800;

  // 图表颜色根据数据类型设置
  let barColor = '#4d7cfe';  // 默认蓝色
  if (key === 'userId') {
    barColor = '#ff6b81';    // 用户统计粉色
  } else if (key === 'guildId') {
    barColor = '#5dd5a8';    // 群组统计绿色
  }

  // 生成HTML图表
  const html = generateStatChartHtml(title, chartData, key, {
    width,
    height,
    barColor
  });

  // 渲染为图片
  return await htmlToImage(html, ctx, { width, height });
}
