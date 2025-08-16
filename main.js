/**************** 基础配置 ****************/
// 当没有config.setItem时，调用config.getItem会返回defaultConfig中的值

defaultConfig["ext.amll-connector.server"] = "localhost:11444";
SettingsPage.data.push(
    {type: "title", text: "[功能扩展] AMLL连接器"},
    {
        type: "button",
        text: "温馨提示",
        description: "本扩展需要在AMLL启动ws protocol连接协议后才可正常使用",
        button: "前往下载",
        onclick: () => {
            webview(`https://github.com/Steve-xmh/applemusic-like-lyrics/actions/workflows/build-player.yaml`, {
                width: 1100,
                height: 750
            });
        }
    },
    {
        type: "input",
        text: "播放器连接地址",
        description: "在AMLL内显示的连接地址",
        configItem: "ext.amll-connector.server"
    },
    {
        configItem: 'ext.amll-connector.enabled',
        type: 'boolean',
        text: '启动连接模式',
        description: "启动连接模式后，若未连接成功，则每5s会重试",
        default: false
    },
);

// 保存WebSocket连接和重试定时器的引用
let socket = null;
let retryTimer = null;
let isConnected = false;

// 创建WebSocket连接的函数
function createWebSocket() {
    // 如果连接模式未启用，则不创建连接
    if (!config.getItem("ext.amll-connector.enabled")) {
        return;
    }

    // 如果已经连接，则先关闭现有连接
    if (socket) {
        socket.close();
        socket = null;
    }

    const serverAddress = config.getItem("ext.amll-connector.server");
    socket = new WebSocket('ws://' + serverAddress);

    // 连接成功时的处理
    socket.onopen = function () {
        console.log('AMLL连接已建立');
        isConnected = true;
        initializeListeners(); // 连接成功时初始化监听器

        // 发送初始暂停消息
        // const pauseMsg = toBody({type: 'pause'});
        // socket.send(pauseMsg);
    };

    // 连接关闭时的处理
    socket.onclose = function () {
        console.log('AMLL连接已关闭');
        isConnected = false;
        destroyListeners(); // 连接关闭时销毁监听器

        // 如果连接模式仍然启用，则5秒后重试
        if (config.getItem("ext.amll-connector.enabled")) {
            retryTimer = setTimeout(() => {
                createWebSocket();
            }, 5000);
        }
    };

    // 连接错误时的处理
    socket.onerror = function (error) {
        console.error('AMLL连接发生错误:', error);
        isConnected = false;
    };

    socket.binaryType = 'arraybuffer';

    // 接收消息的处理
    socket.onmessage = function (event) {
        let bytes;
        let message;

        if (event.data instanceof ArrayBuffer) {
            bytes = new Uint8Array(event.data);
        } else if (event.data instanceof Blob) {
            console.error('WebSocket binaryType should be "arraybuffer", not "blob"');
            return;
        } else {
            console.error('Unknown data type:', typeof event.data, event.data);
            return;
        }

        if (bytes.length < 2) {
            console.warn('Message too short:', bytes.length, 'bytes. Expected at least 2 for magic number.');
            console.log('Raw:', [...bytes]);
            return;
        }

        try {
            message = parseBody(bytes);
            console.log('Parsed:', message);
        } catch (e) {
            console.error('Parse failed:', e.message);
            console.log('Raw hex:', Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' '));
        }
        // const message = parseBody(new Uint8Array(event.data));
        // console.log('Received message:', message);
        switch (message.type) {
            case 'ping':
                const pingMsg = toBody({type: 'pong'});
                socket.send(pingMsg);
                break;
            case 'pause':
                SimAPControls.togglePlay(false);
                break;
            case 'resume':
                SimAPControls.togglePlay(true);
                break;
            case 'forwardSong':
                SimAPControls.next(true)
                break;
            case 'backwardSong':
                SimAPControls.prev(true)
                break;
            case 'setVolume':
                // 检查message.value是否为有效数值
                if (typeof message.volume === 'number' && isFinite(message.volume)) {
                    // 确保音量值在有效范围内(0-1)
                    const volumeValue = Math.max(0, Math.min(1, message.volume));
                    config.setItem("volume", volumeValue);
                }
                break;
            case 'seekPlayProgress':
                const audioElement = document.getElementById('audio');
                if (audioElement) {
                    audioElement.currentTime = message.value.progress / 1000;
                }
                break;
        }
    };
}

// 监听器相关变量
let progressObserver = null;
let volumeObserver = null;
let observerForElement = null;
let lyricsObserver = null;

// 初始化所有监听器
function initializeListeners() {
    // 发送播放进度 - 改为监听audio标签的timeupdate事件
    const audioElement = document.getElementById('audio');
    if (audioElement) {
        // 使用timeupdate事件监听播放进度变化
        let lastTime = -1;
        const handleTimeUpdate = () => {
            if (audioElement && socket && socket.readyState === WebSocket.OPEN) {
                const currentTime = Math.floor(audioElement.currentTime * 1000); // 转换为毫秒
                if (currentTime !== lastTime) {
                    lastTime = currentTime;
                    const progressMsg = toBody({
                        type: 'onPlayProgress',
                        value: {progress: currentTime}
                    });
                    socket.send(progressMsg);
                }
            }
        };
        audioElement.addEventListener('timeupdate', handleTimeUpdate);
    }

    // 发送播放音量
    const volumeElement = document.getElementById('volBarBottom');
    if (volumeElement) {
        volumeObserver = new MutationObserver(mutations => {
            mutations.forEach(mutation => {
                if (mutation.type === 'attributes' && mutation.attributeName === 'value') {
                    const volumeElement = document.getElementById('volBarBottom');
                    if (volumeElement) {
                        const volumeValue = parseInt(volumeElement.value, 10);
                        if (!isNaN(volumeValue) && socket && socket.readyState === WebSocket.OPEN) {
                            const volumeMsg = toBody({
                                type: 'onVolumeChanged',
                                value: {volume: volumeValue}
                            });
                            socket.send(volumeMsg);
                        }
                    }
                }
            });
        });
        volumeObserver.observe(volumeElement, {attributes: true, attributeFilter: ['value']});
    }

    let lastHandle;

    // 发送音乐信息
    observerForElement = new MutationObserver((mutationsList, observer) => {
        mutationsList.forEach((mutation) => {
            if (mutation.type === 'childList') {
                const targetElement = document.querySelector('.SimLRC');
                if (targetElement) {
                    observer.disconnect();
                    lyricsObserver = new MutationObserver(() => {
                        // 发送音乐信息
                        if (socket && socket.readyState === WebSocket.OPEN) {
                            const musicId = config.getItem('currentMusic');
                            if (lastHandle === musicId) return;
                            lastHandle = musicId;
                            const musicMsg = toBody({
                                type: 'setMusicInfo',
                                value: {
                                    musicId: musicId,
                                    musicName: document.querySelector('.musicInfo b') ? document.querySelector('.musicInfo b').innerText : '未知音乐',
                                    albumId: "",
                                    albumName: "",
                                    artists: document.querySelector('.musicInfo div') ? document.querySelector('.musicInfo div').innerText.split(',').map(name => ({
                                        id: name,
                                        name
                                    })) : [{id: 'Null', name: '未知歌手'}],
                                    duration: (() => {
                                        const durationElement = document.getElementById('progressDuration');
                                        if (durationElement) {
                                            const timeString = durationElement.innerHTML.trim();
                                            const totalMilliseconds = parseTimeString(timeString);
                                            if (totalMilliseconds !== null) {
                                                return totalMilliseconds;
                                            }
                                        }
                                        return 240000;
                                    })()
                                }
                            });
                            socket.send(musicMsg);

                            const lyricsMsg = toBody({
                                type: 'setLyricFromTTML',
                                value: {
                                    data: ''
                                },
                            });
                            socket.send(lyricsMsg);

                            // 修改歌词发送逻辑：支持NCM歌词获取
                            // const musicId = config.getItem('currentMusic');
                            if (musicId && musicId.startsWith('ncm:')) {
                                const ncmId = musicId.substring(4);
                                fetch(`https://amll.mirror.dimeta.top/api/db/ncm-lyrics/${ncmId}.ttml`)
                                    .then(response => {
                                        if (!response.ok) {
                                            throw new Error(`HTTP error! status: ${response.status}`);
                                        }
                                        return response.text();
                                    })
                                    .then(ttmlData => {
                                        const lyricsMsg = toBody({
                                            type: 'setLyricFromTTML',
                                            value: {
                                                data: ttmlData
                                            },
                                        });
                                        socket.send(lyricsMsg);
                                    })
                                    .catch(error => {
                                        console.error('获取TTML歌词失败:', error, ",正在尝试从网易云获取");
                                        fetch(`https://ncm-api.3r60.top/lyric/new?id=${ncmId}`)
                                            .then(response => response.json())
                                            .then(async neteaseData => {
                                                let ttmlData = await neteaseToTtmlLrc(neteaseData, {
                                                    ncmMusicId: ncmId,
                                                    musicName: document.querySelector('.musicInfo b') ? document.querySelector('.musicInfo b').innerText : '未知音乐',
                                                    // artists: document.querySelector('.musicInfo div') ? document.querySelector('.musicInfo div').innerText.split(',').map(name => ({
                                                    //     id: name,
                                                    //     name
                                                    // })) : [{id: 'Null', name: '未知歌手'}],
                                                });
                                                console.log("TTML数据:", ttmlData);
                                                const lyricsMsg = toBody({
                                                    type: 'setLyricFromTTML',
                                                    value: {
                                                        data: ttmlData
                                                    },
                                                });
                                                socket.send(lyricsMsg);
                                            })
                                            .catch(error => {
                                                console.error('获取网易云歌词失败:', error);
                                                const lyricsMsg = toBody({
                                                    type: 'setLyricFromTTML',
                                                    value: {
                                                        data: ''
                                                    },
                                                });
                                                socket.send(lyricsMsg);
                                            });

                                    });
                            } else {
                                const lyricsMsg = toBody({
                                    type: 'setLyricFromTTML',
                                    value: {
                                        data: ''
                                    },
                                });
                                socket.send(lyricsMsg);
                            }
                        }

                        // 发送专辑封面
                        if (socket && socket.readyState === WebSocket.OPEN) {
                            const albumImgMsg = toBody({
                                type: 'setMusicAlbumCoverImageURI',
                                value: {
                                    imgUrl: document.querySelector('#album') ? document.querySelector('#album').src : ''
                                }
                            });
                            socket.send(albumImgMsg);
                        }
                    });
                    lyricsObserver.observe(targetElement, {
                        childList: true,
                        subtree: true,
                        characterData: true
                    });
                    window.lyricsObserver = lyricsObserver;
                }
            }
        });
    });

    // 初始观察器的配置
    observerForElement.observe(document.body, {
        childList: true,
        subtree: true
    });

    // 监听audio标签的暂停和播放事件
    if (audioElement) {
        audioElement.addEventListener('pause', handleAudioPause);
        audioElement.addEventListener('play', handleAudioPlay);
    }
}

// 销毁所有监听器
function destroyListeners() {
    if (volumeObserver) {
        volumeObserver.disconnect();
        volumeObserver = null;
    }

    if (observerForElement) {
        observerForElement.disconnect();
        observerForElement = null;
    }

    if (lyricsObserver) {
        lyricsObserver.disconnect();
        lyricsObserver = null;
    }

    // 移除audio标签的事件监听器
    const audioElement = document.getElementById('audio');
    if (audioElement) {
        audioElement.removeEventListener('pause', handleAudioPause);
        audioElement.removeEventListener('play', handleAudioPlay);
        audioElement.removeEventListener('timeupdate', handleTimeUpdate);
    }
}

// 处理音频暂停事件
function handleAudioPause() {
    if (socket && socket.readyState === WebSocket.OPEN) {
        const pauseMsg = toBody({type: 'onPaused'});
        socket.send(pauseMsg);
    }
}

function handleAudioTimeupdate() {
    if (socket && socket.readyState === WebSocket.OPEN) {
        const pauseMsg = toBody({type: 'onPaused'});
        socket.send(pauseMsg);
    }
}


// 处理音频播放事件
function handleAudioPlay() {
    if (socket && socket.readyState === WebSocket.OPEN) {
        const resumeMsg = toBody({type: 'onResumed'});
        socket.send(resumeMsg);
    }
}

// 合并时间处理逻辑：提取为通用函数
function parseTimeString(timeString) {
    const timeParts = timeString.split(':');
    if (timeParts.length === 2) {
        const minutes = parseInt(timeParts[0], 10);
        const seconds = parseInt(timeParts[1], 10);
        if (!isNaN(minutes) && !isNaN(seconds)) {
            return (minutes * 60 + seconds) * 1000;
        }
    }
    return null;
}

// 监听配置变化，控制连接状态
const originalSetItem = config.setItem;
config.setItem = function (key, value) {
    if (key === "ext.amll-connector.enabled") {
        if (value === true && !isConnected) {
            // 启用连接模式
            if (retryTimer) {
                clearTimeout(retryTimer);
                retryTimer = null;
            }
            createWebSocket();
        } else if (value === false && socket) {
            // 禁用连接模式
            if (retryTimer) {
                clearTimeout(retryTimer);
                retryTimer = null;
            }
            socket.close();
            socket = null;
            destroyListeners();
        }
    }
    return originalSetItem.apply(this, arguments);
};

// 初始化连接（如果启用）
if (config.getItem("ext.amll-connector.enabled")) {
    createWebSocket();
}

config.listenChange('ext.amll-connector.enabled', () => {
    createWebSocket();
})

