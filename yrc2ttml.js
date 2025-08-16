async function neteaseToTtmlLrc(data, options = {}) {
    const {
        ncmMusicId = '',
        qqMusicId = '',
        ttmlAuthorGithub = '',
        ttmlAuthorGithubLogin = ''
    } = options;

    const {lrc, tlyric, yrc, ytlrc} = data;

    // ================= 工具函数 =================
    function msToTtmlTime(ms) {
        const total = ms / 1000;
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = (total % 60).toFixed(3).padStart(6, '0');
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s}`;
    }

    function escapeXml(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '<')
            .replace(/>/g, '>')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    // ================= 解析 yrc =================
    function parseYrc(lyricText) {
        const lines = lyricText.trim().split(/\r?\n/);
        const result = [];
        // 修改正则表达式以正确捕获所有内容
        const lineRegex = /^\[(\d+),(\d+)](.*)$/;
        const wordRegex = /\((\d+),(\d+),\d+\)([^()]+)/g;

        for (const line of lines) {
            const match = line.match(lineRegex);
            if (!match) continue;

            const startTime = parseInt(match[1]);
            const duration = parseInt(match[2]);
            const endTime = startTime + duration;
            const content = match[3];

            const words = [];
            let wordMatch;
            // 修复：确保能正确处理所有单词
            while ((wordMatch = wordRegex.exec(content)) !== null) {
                const wStart = parseInt(wordMatch[1]);
                const wDur = parseInt(wordMatch[2]);
                words.push({
                    text: wordMatch[3],
                    start: wStart,
                    end: wStart + wDur
                });
            }

            // 修复：处理没有被wordRegex匹配到的纯文本行
            if (words.length === 0 && content.trim()) {
                words.push({
                    text: content.replace(/^\((.*)\)$/, '$1'), // 移除可能存在的括号
                    start: startTime,
                    end: endTime
                });
            }

            result.push({startTime, endTime, words});
        }

        return result.length > 0 ? result : null;
    }

    // ================= 解析 lrc（降级）=================
    function parseLrc(lyricText) {
        // ID 标签正则（以 [id: 开头的行）
        const idTagRegex = /^\[(?:ti|ar|al|au|by|re|ve|offset|length):/i;
        // 时间标签正则（提取用）
        const timeRegex = /\[(\d{1,2}):(\d{2}(?:\.\d{2,3})?)]/g;
        // 用于判断是否是时间标签行（非ID）
        const hasTimeRegex = /\[\d{1,2}:\d{2}(?:\.\d{2,3})?]/;

        const lines = lyricText.trim().split(/\r?\n/);
        const result = [];

        // 先过滤出有效的歌词行（包含时间标签且非ID标签）
        const validLines = lines.filter(line => {
            return hasTimeRegex.test(line) && !idTagRegex.test(line.trim());
        });

        // 提取所有带时间的行及其时间点
        const parsedLines = validLines.map(line => {
            const times = [];
            let match;
            // 使用全局正则匹配所有时间标签
            while ((match = timeRegex.exec(line)) !== null) {
                const mm = parseInt(match[1], 10);
                const ss = parseFloat(match[2]);
                const ms = Math.round((mm * 60 + ss) * 1000);
                times.push(ms);
            }
            // 移除所有时间标签，获取纯文本
            const text = line.replace(/\[\d{1,2}:\d{2}(?:\.\d{2,3})?]/g, '').trim();
            return {times, text};
        }).filter(item => item.times.length > 0 && item.text);

        // 如果没有有效歌词行，返回 null
        if (parsedLines.length === 0) {
            return null;
        }

        // 计算每条时间点的 startTime 和 endTime
        for (let i = 0; i < parsedLines.length; i++) {
            const {times, text} = parsedLines[i];

            // 当前行的下一个有效行的第一个时间作为结束时间基准
            let nextTime = null;
            if (i + 1 < parsedLines.length) {
                nextTime = parsedLines[i + 1].times[0]; // 下一行第一个时间
            }

            for (const start of times) {
                let end;
                if (nextTime !== null) {
                    end = nextTime;
                } else {
                    end = start + 4000; // 最后一行，默认持续4秒
                }

                // 确保至少持续1秒
                end = Math.max(start + 1000, end);

                result.push({
                    startTime: start,
                    endTime: end,
                    words: [{text, start, end}]
                });
            }
        }

        return result;
    }

    // ================= 解析翻译 =================
    function parseTimedLyric(lyricText) {
        if (!lyricText?.trim()) return [];
        const lines = lyricText.trim().split(/\r?\n/);
        const result = [];
        const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})]/;

        for (const line of lines) {
            const match = line.match(timeRegex);
            if (!match) continue;
            const m = parseInt(match[1]);
            const s = parseInt(match[2]);
            const ms = match[3].length === 2 ? parseInt(match[3]) * 10 : parseInt(match[3]);
            const timeMs = m * 60000 + s * 1000 + ms;
            const text = line.replace(timeRegex, '').trim();
            if (text) result.push({time: timeMs, text});
        }
        return result;
    }

    // ================= 主逻辑 =================
    let lyricData = null;

    // 1. 优先解析 yrc
    if (yrc?.version > 0 && yrc.lyric?.trim()) {
        lyricData = parseYrc(yrc.lyric);
    }

    // 2. 降级解析 lrc
    if (!lyricData && lrc?.lyric?.trim()) {
        lyricData = parseLrc(lrc.lyric);
    }

    if (!lyricData || lyricData.length === 0) {
        throw new Error('No valid lyric found in yrc or lrc.');
    }

    const tlyricData = parseTimedLyric(tlyric?.lyric);
    parseTimedLyric(ytlrc?.lyric);
// 提取歌曲元信息
    const musicName = options.musicName || '';
    const artists = Array.isArray(options.artists) ? options.artists : [options.artists || 'Unknown'];
    const album = options.album || '';

    // ================= 生成 TTML =================
    let ttml = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" 
    xmlns:ttm="http://www.w3.org/ns/ttml#metadata" 
    xmlns:itunes="http://music.apple.com/lyric-ttml-internal" 
    xmlns:amll="http://www.example.com/ns/amll">
  <head>
    <metadata xmlns="">
      <ttm:agent type="person" xml:id="v1"/>
      <ttm:agent type="other" xml:id="v2"/>
      ${amllMeta('ncmMusicId', ncmMusicId)}
      ${amllMeta('qqMusicId', qqMusicId)}
      ${amllMeta('musicName', musicName)}
      ${artists.map(artist => amllMeta('artists', artist)).join('\n      ')}
      ${amllMeta('album', album)}
      ${amllMeta('ttmlAuthorGithub', ttmlAuthorGithub)}
      ${amllMeta('ttmlAuthorGithubLogin', ttmlAuthorGithubLogin)}
    </metadata>
  </head>
  <body dur="${msToTtmlTime(lyricData[lyricData.length - 1].endTime)}">
    <div xmlns="" begin="00:00.000" end="${msToTtmlTime(lyricData[lyricData.length - 1].endTime)}">
`;

    // 匹配翻译函数
    function findTranslation(startTime) {
        const trans = tlyricData.find(t => Math.abs(t.time - startTime) < 2000);
        return trans ? trans.text : null;
    }

    // 逐行生成
    lyricData.forEach((line, index) => {
        const lineNum = index + 1;
        const lid = `L${lineNum}`;
        const start = msToTtmlTime(line.startTime);
        const end = msToTtmlTime(line.endTime);
        const agent = line.words.some(w => w.text.includes('Yeah') || w.text.includes('Oh')) ? 'v2' : 'v1';
        const translation = findTranslation(line.startTime);

        ttml += `      <p begin="${start}" end="${end}" ttm:agent="v${agent === 'v1' ? '1' : '2'}" itunes:key="${lid}">
`;

        // 原歌词（字级）
        line.words.forEach(word => {
            const wStart = msToTtmlTime(word.start);
            const wEnd = msToTtmlTime(word.end);
            ttml += `<span begin="${wStart}" end="${wEnd}">${escapeXml(word.text)}</span>`;
        });

        // 翻译（整行）
        if (translation) {
            ttml += `        <span ttm:role="x-translation" xml:lang="zh-CN">${escapeXml(translation)}</span>\n`;
        }

        ttml += `      </p>\n`;
    });

    ttml += `    </div>
  </body>
</tt>`;

    return ttml;

    // 工具：生成 amll:meta
    function amllMeta(key, value) {
        return value ? `<amll:meta key="${escapeXml(key)}" value="${escapeXml(value)}"/>` : '';
    }
}