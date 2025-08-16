// amll-protocol.js - 纯 JS 实现 AMLL WebSocket 协议序列化

/**
 * 写入 NullString（UTF-8 编码 + \0 结尾）
 * @param {string} str
 * @returns {Uint8Array}
 */
function writeNullString(str) {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);
    const result = new Uint8Array(bytes.length + 1);
    result.set(bytes, 0);
    result[bytes.length] = 0; // null terminator
    return result;
}

/**
 * 写入 u32（小端）
 * @param {number} value
 * @returns {Uint8Array}
 */
function writeU32(value) {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, value, true); // true = little endian
    return new Uint8Array(buf);
}

/**
 * 写入 u64（小端，JS 中用 BigInt）
 * @param {number|bigint} value
 * @returns {Uint8Array}
 */
function writeU64(value) {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setBigUint64(0, BigInt(value), true);
    return new Uint8Array(buf);
}

/**
 * 写入 f64（小端）
 * @param {number} value
 * @returns {Uint8Array}
 */
function writeF64(value) {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, value, true);
    return new Uint8Array(buf);
}

/**
 * 写入 Vec<T>，T 是一个返回 Uint8Array 的函数
 * @param {any[]} arr
 * @param {(item: any) => Uint8Array} writer
 * @returns {Uint8Array}
 */
function writeVec(arr, writer) {
    const size = writeU32(arr.length);
    const items = arr.map(writer);
    const totalLength = items.reduce((sum, i) => sum + i.length, 0);
    const buffer = new Uint8Array(4 + totalLength);
    let offset = 0;
    buffer.set(size, offset); offset += 4;
    for (const item of items) {
        buffer.set(item, offset);
        offset += item.length;
    }
    return buffer;
}

/**
 * 主函数：序列化 AMLL 消息体
 * @param {object} body - { type: string, value?: any }
 * @returns {Uint8Array}
 */
function toBody(body) {
    const MAGIC_MAP = {
        ping: 0,
        pong: 1,
        setMusicInfo: 2,
        setMusicAlbumCoverImageURI: 3,
        setMusicAlbumCoverImageData: 4,
        onPlayProgress: 5,
        onVolumeChanged: 6,
        onPaused: 7,
        onResumed: 8,
        onAudioData: 9,
        setLyric: 10,
        setLyricFromTTML: 11,
        pause: 12,
        resume: 13,
        forwardSong: 14,
        backwardSong: 15,
        setVolume: 16,
        seekPlayProgress: 17,
    };

    const magic = MAGIC_MAP[body.type];
    if (magic === undefined) {
        throw new Error(`Unknown message type: ${body.type}`);
    }

    const magicBytes = new Uint8Array([magic & 0xff, (magic >> 8) & 0xff]); // u16 小端
    const parts = [magicBytes];

    switch (body.type) {
        case 'ping':
        case 'pong':
        case 'onPaused':
        case 'onResumed':
        case 'pause':
        case 'resume':
        case 'forwardSong':
        case 'backwardSong':
            // 无数据
            break;

        case 'setMusicInfo':
            const v = body.value;
            parts.push(writeNullString(v.musicId));
            parts.push(writeNullString(v.musicName));
            parts.push(writeNullString(v.albumId));
            parts.push(writeNullString(v.albumName));
            parts.push(writeVec(v.artists, artist => {
                return new Uint8Array([
                    ...writeNullString(artist.id),
                    ...writeNullString(artist.name)
                ]);
            }));
            parts.push(writeU64(v.duration));
            break;

        case 'setMusicAlbumCoverImageURI':
            parts.push(writeNullString(body.value.imgUrl));
            break;

        case 'setMusicAlbumCoverImageData':
            parts.push(writeVec(body.value.data, byte => new Uint8Array([byte])));
            break;

        case 'onPlayProgress':
            parts.push(writeU64(body.value.progress));
            break;

        case 'onVolumeChanged':
            parts.push(writeF64(body.value.volume));
            break;
        case 'setVolume':
            parts.push(writeF64(body.value.volume));
            break;

        case 'seekPlayProgress':
            parts.push(writeU64(body.value.progress));
            break;

        case 'setLyric':
            parts.push(writeVec(body.value.data, line => {
                const lineBytes = [
                    ...writeU64(line.startTime),
                    ...writeU64(line.endTime),
                    ...writeVec(line.words || [], word => {
                        return new Uint8Array([
                            ...writeU64(word.startTime),
                            ...writeU64(word.endTime),
                            ...writeNullString(word.word)
                        ]);
                    }),
                    ...writeNullString(line.translatedLyric || ''),
                    ...writeNullString(line.romanLyric || ''),
                    ...new Uint8Array([line.flag || 0]) // u8
                ];
                return new Uint8Array(lineBytes);
            }));
            break;

        case 'setLyricFromTTML':
            parts.push(writeNullString(body.value.data));
            break;

        case 'onAudioData':
            parts.push(writeVec(body.value.data, byte => new Uint8Array([byte])));
            break;

        default:
            throw new Error(`Unsupported message type: ${body.type}`);
    }

    // 合并所有部分
    const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }

    return result;
}

// 以下是反序列化部分

/**
 * 从 Uint8Array 中读取 u16（小端）
 * @param {Uint8Array} buf
 * @param {number} offset
 * @returns {{ value: number, offset: number }}
 */
function readU16(buf, offset) {
    const value = buf[offset] | (buf[offset + 1] << 8);
    return { value, offset: offset + 2 };
}

/**
 * 从 Uint8Array 中读取 u32（小端）
 * @param {Uint8Array} buf
 * @param {number} offset
 * @returns {{ value: number, offset: number }}
 */
function readU32(buf, offset) {
    const value = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
        .getUint32(offset, true);
    return { value, offset: offset + 4 };
}

/**
 * 从 Uint8Array 中读取 u64（小端） 返回 BigInt  转为 JS number（注意精度）
 * @param {Uint8Array} buf
 * @param {number} offset
 * @returns {{ value: number, offset: number }}
 */
function readU64(buf, offset) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const value = dv.getBigUint64(offset, true);
    // 注意：> 2^53-1 时可能丢失精度，但音乐时间一般 < 1小时=3600000ms，安全
    return { value: Number(value), offset: offset + 8 };
}

/**
 * 从 Uint8Array 中读取 f64（小端）
 * @param {Uint8Array} buf
 * @param {number} offset
 * @returns {{ value: number, offset: number }}
 */
function readF64(buf, offset) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const value = dv.getFloat64(offset, true);
    return { value, offset: offset + 8 };
}

/**
 * 从 offset 开始读取 NullString（UTF-8 + \0）
 * @param {Uint8Array} buf
 * @param {number} offset
 * @returns {{ value: string, offset: number }}
 */
function readNullString(buf, offset) {
    let end = offset;
    while (end < buf.length && buf[end] !== 0) end++;
    if (end >= buf.length) throw new Error('NullString not terminated');
    const bytes = buf.subarray(offset, end);
    const value = new TextDecoder('utf-8').decode(bytes);
    return { value, offset: end + 1 }; // 跳过 \0
}

/**
 * 读取 Vec<T>，T 由 reader 函数定义
 * @param {Uint8Array} buf
 * @param {number} offset
 * @param {(buf: Uint8Array, offset: number) => { value: any, offset: number }} reader
 * @returns {{ value: any[], offset: number }}
 */
function readVec(buf, offset, reader) {
    const { value: len, offset: nextOffset } = readU32(buf, offset);
    let items = [];
    let currentOffset = nextOffset;
    for (let i = 0; i < len; i++) {
        const result = reader(buf, currentOffset);
        items.push(result.value);
        currentOffset = result.offset;
    }
    return { value: items, offset: currentOffset };
}

/**
 * 读取 Artist 结构
 * @param {Uint8Array} buf
 * @param {number} offset
 * @returns {{ value: { id: string, name: string }, offset: number }}
 */
function readArtist(buf, offset) {
    const { value: id, offset: o1 } = readNullString(buf, offset);
    const { value: name, offset: o2 } = readNullString(buf, o1);
    return { value: { id, name }, offset: o2 };
}

/**
 * 读取 LyricWord 结构
 * @param {Uint8Array} buf
 * @param {number} offset
 * @returns {{ value: { startTime: number, endTime: number, word: string }, offset: number }}
 */
function readLyricWord(buf, offset) {
    const { value: startTime, offset: o1 } = readU64(buf, offset);
    const { value: endTime, offset: o2 } = readU64(buf, o1);
    const { value: word, offset: o3 } = readNullString(buf, o2);
    return { value: { startTime, endTime, word }, offset: o3 };
}



/**
 * 读取 LyricLine 结构
 * @param {Uint8Array} buf
 * @param {number} offset
 * @returns {{ value, offset: number }}
 */
function readLyricLine(buf, offset) {
    const { value: startTime, offset: o1 } = readU64(buf, offset);
    const { value: endTime, offset: o2 } = readU64(buf, o1);
    const { value: words, offset: o3 } = readVec(buf, o2, readLyricWord);
    const { value: translatedLyric, offset: o4 } = readNullString(buf, o3);
    const { value: romanLyric, offset: o5 } = readNullString(buf, o4);
    const flag = buf[o5]; // u8
    return {
        value: {
            startTime,
            endTime,
            words,
            translatedLyric,
            romanLyric,
            flag
        },
        offset: o5 + 1
    };
}

/**
 * 主函数：反序列化 AMLL 消息体
 * @param {Uint8Array} bytes
 * @returns  type: string, value?: any 
 */
function parseBody(bytes) {
    console.log('Parsing buffer of length:', bytes.length);
    console.log('First 16 bytes:', [...bytes.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')));
    const MAGIC_MAP = {
        0: 'ping',
        1: 'pong',
        2: 'setMusicInfo',
        3: 'setMusicAlbumCoverImageURI',
        4: 'setMusicAlbumCoverImageData',
        5: 'onPlayProgress',
        6: 'onVolumeChanged',
        7: 'onPaused',
        8: 'onResumed',
        9: 'onAudioData',
        10: 'setLyric',
        11: 'setLyricFromTTML',
        12: 'pause',
        13: 'resume',
        14: 'forwardSong',
        15: 'backwardSong',
        16: 'setVolume',
        17: 'seekPlayProgress'
    };

    let offset = 0;

    // 读取 Magic Number (u16)
    const { value: magic, offset: nextOffset } = readU16(bytes, offset);
    offset = nextOffset;

    const type = MAGIC_MAP[magic];
    if (!type) throw new Error(`Unknown magic number: ${magic}`);

    let value;

    switch (type) {
        case 'ping':
        case 'pong':
        case 'onPaused':
        case 'onResumed':
        case 'pause':
        case 'resume':
        case 'forwardSong':
        case 'backwardSong':
            // 无数据
            break;

        case 'setMusicInfo':
            const { value: musicId, offset: o1 } = readNullString(bytes, offset);
            const { value: musicName, offset: o2 } = readNullString(bytes, o1);
            const { value: albumId, offset: o3 } = readNullString(bytes, o2);
            const { value: albumName, offset: o4 } = readNullString(bytes, o3);
            const { value: artists, offset: o5 } = readVec(bytes, o4, readArtist);
            const { value: duration, offset: o6 } = readU64(bytes, o5);
            value = { musicId, musicName, albumId, albumName, artists, duration };
            offset = o6;
            break;

        case 'setMusicAlbumCoverImageURI':
            const { value: imgUrl, offset: o7 } = readNullString(bytes, offset);
            value = { imgUrl };
            offset = o7;
            break;

        case 'setMusicAlbumCoverImageData':
            const { value: data, offset: o8 } = readVec(bytes, offset, (buf, off) => ({ value: buf[off], offset: off + 1 }));
            value = { data };
            offset = o8;
            break;

        case 'onPlayProgress':
            const { value: progress, offset: o9 } = readU64(bytes, offset);
            value = { progress };
            offset = o9;
            break;

        case 'onVolumeChanged':
        case 'setVolume':
            const { value: volume, offset: o10 } = readF64(bytes, offset);
            value = { volume };
            offset = o10;
            break;

        case 'seekPlayProgress':
            const { value: seekProgress, offset: o11 } = readU64(bytes, offset);
            value = { progress: seekProgress };
            offset = o11;
            break;

        case 'onAudioData':
            const { value: audioData, offset: o12 } = readVec(bytes, offset, (buf, off) => ({ value: buf[off], offset: off + 1 }));
            value = { data: audioData };
            offset = o12;
            break;

        case 'setLyric':
            const { value: lyricData, offset: o13 } = readVec(bytes, offset, readLyricLine);
            value = { data: lyricData };
            offset = o13;
            break;

        case 'setLyricFromTTML':
            const { value: ttmlData, offset: o14 } = readNullString(bytes, offset);
            value = { data: ttmlData };
            offset = o14;
            break;

        default:
            throw new Error(`Unsupported message type: ${type}`);
    }

    // 确保没有多余数据（可选）
    // if (offset !== bytes.length) {
    //     console.warn(`Warning: ${bytes.length - offset} bytes left unparsed`);
    // }

    return { type, value };
}