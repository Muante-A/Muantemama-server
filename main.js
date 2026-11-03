const { app, BrowserWindow, ipcMain, clipboard, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const YTDlpWrap = require('yt-dlp-wrap').default;
const ffmpegPath = require('ffmpeg-static');

let mainWindow;
let ytDlpWrap = null;
let setupPromise = null;
let isDownloading = false;

// yt-dlp hi site-te a siam danglam thin avangin a hlui lutuk chuan update tur
const MAX_BINARY_AGE_MS = 3 * 24 * 60 * 60 * 1000; // ni 3

const binDir = path.join(app.getPath('userData'), 'bin');
const binaryPath = path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

// Packaged app (asar) chhunga ffmpeg path dik tak
const actualFfmpegPath = ffmpegPath ? ffmpegPath.replace('app.asar', 'app.asar.unpacked') : null;

function sendProgress(percent, status) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-progress', { percent, status });
    }
}

const logPath = path.join(app.getPath('userData'), 'downloader-log.txt');
function log(line) {
    try { fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`); } catch (_) {}
}

// yt-dlp download / update
async function ensureBinary() {
    fs.mkdirSync(binDir, { recursive: true });

    const exists = fs.existsSync(binaryPath);
    const stale = exists && (Date.now() - fs.statSync(binaryPath).mtimeMs > MAX_BINARY_AGE_MS);

    if (exists && !stale) return;

    if (!setupPromise) {
        setupPromise = (async () => {
            sendProgress(
                3,
                exists
                    ? 'Video Engine update mek a ni (Second 10 vel nghak rawh)...'
                    : 'A vawi khatna atan Video Engine setup mek a ni (Second 10 vel nghak rawh)...'
            );
            const tmpPath = binaryPath + '.new';
            try {
                await YTDlpWrap.downloadFromGithub(tmpPath);
                if (process.platform !== 'win32') fs.chmodSync(tmpPath, 0o755);
                fs.renameSync(tmpPath, binaryPath);
            } catch (e) {
                try { fs.unlinkSync(tmpPath); } catch (_) {}
                // Hlui a awm tawh chuan chu chu hmang zel; a awm loh chuan error
                if (!exists) {
                    throw new Error('Video Engine (yt-dlp) download theih a ni lo. Internet connection enfiah la, a nawn leh rawh.');
                }
                // update a hlawhchham a, nimahsela hlui hmang zel tur: ni 3 tawp lo tur in mtime thar
                try { const now = new Date(); fs.utimesSync(binaryPath, now, now); } catch (_) {}
            }
        })().finally(() => { setupPromise = null; });
    }
    await setupPromise;
}

async function getYtDlp() {
    await ensureBinary();
    if (!ytDlpWrap) ytDlpWrap = new YTDlpWrap(binaryPath);
    return ytDlpWrap;
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 480,
        height: 750,
        resizable: false,
        icon: path.join(__dirname, 'icon.ico'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.loadFile('index.html');
    mainWindow.setMenu(null);

    // Right-click Cut/Copy/Paste menu
    mainWindow.webContents.on('context-menu', (event, params) => {
        const menu = Menu.buildFromTemplate([
            { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut },
            { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
            { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste },
            { type: 'separator' },
            { label: 'Select All', role: 'selectAll' }
        ]);
        menu.popup(mainWindow);
    });
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// 1. Clipboard
ipcMain.handle('read-clipboard', () => {
    return clipboard.readText() || '';
});

// ---------- Helpers ----------

function cleanYtDlpError(err) {
    const raw = String((err && err.message) || err || '');
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const errLines = lines.filter(l => /^ERROR:/i.test(l));
    const last = errLines.length ? errLines[errLines.length - 1] : (lines[lines.length - 1] || 'Unknown error');
    return last.replace(/^ERROR:\s*/i, '').replace(/\x1B\[[0-9;]*m/g, '');
}

function needsLogin(msg) {
    return /log ?in|sign in|cookies|private|authentication|authorization|rate-limit|empty media response|not a bot|confirm your age|age[- ]restricted|members only/i.test(msg);
}

// yt-dlp run pakhat (spawn hmangin, progress mal chhiar). Resolve = zo, reject = error
function runYtDlp(args) {
    return new Promise((resolve, reject) => {
        log('RUN yt-dlp ' + args.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' '));

        const proc = spawn(binaryPath, args, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stderr = '';
        let outBuf = '';
        let errBuf = '';
        let lastPct = 0;

        const handleLine = (line) => {
            line = line.replace(/\x1B\[[0-9;]*m/g, '').trim();
            if (!line) return;
            log(line);

            const m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
            if (m) {
                const pct = Math.min(99, Math.max(5, Math.floor(parseFloat(m[1]))));
                lastPct = pct;
                const speed = (line.match(/at\s+([\d.]+\s*\S+\/s)/) || [])[1];
                sendProgress(pct, `Downloading... ${pct}%` + (speed ? ` • ${speed}` : ''));
            } else if (/\[Merger\]|\[VideoRemuxer\]|\[Fixup/i.test(line)) {
                sendProgress(99, 'Video leh audio pawlh mek...');
            } else if (/\[download\]\s+Destination/i.test(line)) {
                sendProgress(Math.max(lastPct, 5), 'Downloading...');
            } else if (/^\[(?!download)[^\]]+\]/.test(line)) {
                sendProgress(Math.max(lastPct, 5), 'Video info zawn mek...');
            }
        };

        const feed = (chunk, which) => {
            let buf = (which === 'out' ? outBuf : errBuf) + chunk.toString();
            const parts = buf.split(/\r|\n/);
            buf = parts.pop();
            if (which === 'out') outBuf = buf; else errBuf = buf;
            parts.forEach(handleLine);
        };

        proc.stdout.on('data', d => feed(d, 'out'));
        proc.stderr.on('data', d => { stderr += d.toString(); feed(d, 'err'); });

        proc.on('error', (err) => {
            log('SPAWN ERROR ' + err.message);
            reject(new Error('yt-dlp run theih a ni lo: ' + err.message));
        });

        proc.on('close', (code) => {
            log('EXIT code ' + code);
            if (code === 0) resolve();
            else reject(new Error(stderr || ('yt-dlp exit code ' + code)));
        });
    });
}

// Folder chhunga video file dik ber (a lian ber) zawn
function findOutputFile(dir) {
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir)
        .filter(f => !/\.(part|ytdl|temp|tmp|jpg|jpeg|png|webp|vtt|srt|json)$/i.test(f) && !/\.f\d+\./.test(f))
        .map(f => ({ f, p: path.join(dir, f), size: fs.statSync(path.join(dir, f)).size }))
        .filter(x => x.size > 0)
        .sort((a, b) => b.size - a.size);
    return files.length ? files[0] : null;
}

function uniquePath(dir, name) {
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    let candidate = path.join(dir, name);
    let i = 1;
    while (fs.existsSync(candidate)) {
        candidate = path.join(dir, `${base} (${i++})${ext}`);
    }
    return candidate;
}

// 2. Video Downloader
ipcMain.handle('download-video', async (event, { url, quality }) => {
    if (!url || !/^https?:\/\/\S+$/i.test(url)) {
        throw new Error('Video link dik tak dah rawh.');
    }
    if (isDownloading) {
        throw new Error('Download dang a la kal mek. A zo hma chuan nghak rawh.');
    }

    isDownloading = true;
    let workDir = null;

    try {
        await ensureBinary();

        let height = '720';
        if (quality.includes('1080')) height = '1080';
        else if (quality.includes('480')) height = '480';
        else if (quality.includes('360')) height = '360';

        const downloadsPath = app.getPath('downloads');
        workDir = path.join(downloadsPath, `.muantemama-tmp-${Date.now()}`);
        fs.mkdirSync(workDir, { recursive: true });

        const baseArgs = [
            url,
            // Video + audio sang a awm thin (YouTube, FB, IG, TikTok...) - ffmpeg hmangin pawlh
            '-f', 'bv*+ba/b',
            // Quality thlan chin ang a hnai ber, mp4/m4a duhsak
            '-S', `res:${height},ext:mp4:m4a`,
            '--merge-output-format', 'mp4',
            '--no-playlist',
            '--no-check-certificates',
            '--windows-filenames',
            '--no-mtime',
            '--newline',
            '--retries', '5',
            '--fragment-retries', '5',
            '--concurrent-fragments', '4',
            '--socket-timeout', '30',
            '-o', path.join(workDir, '%(title).120B [%(id)s].%(ext)s')
        ];

        if (actualFfmpegPath && fs.existsSync(actualFfmpegPath)) {
            baseArgs.push('--ffmpeg-location', actualFfmpegPath);
        }

        sendProgress(5, 'Video stream zawng mek a ni...');
        log('URL: ' + url + ' | quality: ' + quality);

        try {
            await runYtDlp(baseArgs);
        } catch (firstErr) {
            const firstMsg = cleanYtDlpError(firstErr);

            // Login/cookies mamawh a nih chuan browser cookies hmangin tidanglai
            if (!needsLogin(firstMsg)) throw new Error(firstMsg);

            let succeeded = false;
            for (const browser of ['chrome', 'edge', 'firefox']) {
                try {
                    sendProgress(5, `${browser} cookies hmangin tidanglai mek...`);
                    await runYtDlp([...baseArgs, '--cookies-from-browser', browser]);
                    succeeded = true;
                    break;
                } catch (_) { /* browser dang tidanglai */ }
            }
            if (!succeeded) {
                throw new Error(
                    firstMsg +
                    ' — He video hi login a mamawh pawh a ni thei. Chrome/Edge/Firefox-ah login hmasa la, a nawn leh rawh.'
                );
            }
        }

        const out = findOutputFile(workDir);
        if (!out) {
            throw new Error('Video download theih a ni lo. Link hi a dik em tih enfiah rawh.');
        }

        const finalPath = uniquePath(downloadsPath, out.f);
        fs.renameSync(out.p, finalPath);
        shell.showItemInFolder(finalPath);

        return { success: true, path: finalPath, size: out.size };
    } finally {
        isDownloading = false;
        if (workDir) {
            try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
        }
    }
});