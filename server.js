// Muantemama Media Downloader Server
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

const PORT = parseInt(process.env.PORT || '10000', 10);
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const FFMPEG_DIR = process.env.FFMPEG_DIR || '';
const COOKIES_FILE = process.env.COOKIES_FILE || '';
const WORK_DIR = process.env.WORK_DIR || path.join(os.tmpdir(), 'muantemama-jobs');
const MAX_FILESIZE = process.env.MAX_FILESIZE || '1G';

const TTL_MS = 15 * 60 * 1000;
const MAX_RUNNING = 2;
const JOBS_PER_HOUR = 30;

fs.mkdirSync(WORK_DIR, { recursive: true });

const jobs = new Map();
const rate = new Map();

function isPrivateIp(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return a === 10 || a === 127 || a === 0 ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 100 && b >= 64 && b <= 127);
    }

    if (net.isIPv6(ip)) {
        const l = ip.toLowerCase();
        return l === '::1' || l === '::' ||
            l.startsWith('fc') || l.startsWith('fd') ||
            l.startsWith('fe80') || l.startsWith('::ffff:');
    }

    return true;
}

async function validateUrl(raw) {
    let u;

    try {
        u = new URL(raw);
    } catch {
        throw new Error('Video link dik lo.');
    }

    if (!/^https?:$/.test(u.protocol)) {
        throw new Error('HTTP/HTTPS link chauh a phal.');
    }

    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(host)
        ? [{ address: host }]
        : await dns.lookup(host, { all: true });

    if (!addresses.length || addresses.some(a => isPrivateIp(a.address))) {
        throw new Error('He link hi a phal lo.');
    }

    return u.toString();
}

function rateLimited(ip) {
    const now = Date.now();
    const list = (rate.get(ip) || [])
        .filter(t => now - t < 3600000);

    if (list.length >= JOBS_PER_HOUR) {
        rate.set(ip, list);
        return true;
    }

    list.push(now);
    rate.set(ip, list);
    return false;
}

function lastErrorLine(text) {
    const lines = String(text)
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean);

    const errors = lines.filter(l => /^ERROR:/i.test(l));

    return (
        errors.length
            ? errors[errors.length - 1]
            : (lines[lines.length - 1] || 'Unknown error')
    ).replace(/^ERROR:\s*/i, '');
}

function findOutput(dir) {
    const files = fs.readdirSync(dir)
        .filter(f =>
            !/\.(part|ytdl|temp|tmp|jpg|jpeg|png|webp|vtt|srt|json)$/i.test(f) &&
            !/\.f\d+\./.test(f)
        )
        .map(f => ({
            f,
            p: path.join(dir, f),
            size: fs.statSync(path.join(dir, f)).size
        }))
        .filter(x => x.size > 0)
        .sort((a, b) => b.size - a.size);

    return files[0] || null;
}

function runningCount() {
    let count = 0;

    for (const job of jobs.values()) {
        if (job.status === 'running') count++;
    }

    return count;
}

function removeJob(id) {
    const job = jobs.get(id);
    if (!job) return;

    try {
        fs.rmSync(job.dir, { recursive: true, force: true });
    } catch (_) {}

    jobs.delete(id);
}

// DOWNLOAD JOB
function startJob(job) {
    let height = '720';

    if (/1080/.test(job.quality)) height = '1080';
    else if (/480/.test(job.quality)) height = '480';
    else if (/360/.test(job.quality)) height = '360';

    const args = [
        job.url,
        '-f',
        `bestvideo[height<=${height}][vcodec^=avc1][ext=mp4]+bestaudio[acodec^=mp4a]/bestvideo[height<=${height}][ext=mp4]+bestaudio/best[height<=${height}][ext=mp4]/best[height<=${height}]/best`,
        '-S', 'res,fps,vcodec:h264,acodec:aac,ext:mp4:m4a',
        '--merge-output-format', 'mp4',
        '--no-playlist',
        '--windows-filenames',
        '--no-mtime',
        '--newline',
        '--retries', '10',
        '--fragment-retries', '10',
        '--retry-sleep', 'fragment:1:5',
        '--socket-timeout', '20',
        '--concurrent-fragments', '8',
        '--buffer-size', '16K',
        '--max-filesize', MAX_FILESIZE,
        '--js-runtimes', 'node',
        '--remote-components', 'ejs:github',
        '-o', path.join(job.dir, '%(title).100B [%(id)s].%(ext)s')
    ];

    if (FFMPEG_DIR) {
        args.push('--ffmpeg-location', FFMPEG_DIR);
    }

    if (COOKIES_FILE && fs.existsSync(COOKIES_FILE)) {
        args.push('--cookies', COOKIES_FILE);
    }

    const proc = spawn(YTDLP, args, {
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';
    let buffer = '';

    proc.stdout.on('data', data => {
        buffer += data.toString();
        const parts = buffer.split(/\r|\n/);
        buffer = parts.pop();

        parts.forEach(line => {
            const match = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);

            if (match) {
                // Overall job progress: yt-dlp download occupies 0-70%.
                // The remaining range is reserved for iPhone conversion and file transfer.
                const downloadPercent = Math.max(0, Math.min(100, parseFloat(match[1])));
                job.percent = Math.min(69, Math.round(downloadPercent * 0.69));
                job.message = `Server-in video download mek... ${Math.round(downloadPercent)}%`;
            } else if (/\[Merger\]|\[VideoRemuxer\]/i.test(line)) {
                job.percent = 70;
                job.message = 'Video leh audio pawlh mek...';
            }
        });
    });

    proc.stderr.on('data', data => {
        stderr += data.toString();
        console.error('YT-DLP:', data.toString());
    });

    const killTimer = setTimeout(() => {
        try {
            proc.kill('SIGKILL');
        } catch (_) {}
    }, 20 * 60 * 1000);

    proc.on('error', error => {
        clearTimeout(killTimer);
        job.status = 'error';
        job.message = 'yt-dlp run theih a ni lo: ' + error.message;
        console.error('YT-DLP SPAWN ERROR:', error.message);
    });

    proc.on('close', code => {
        clearTimeout(killTimer);

        if (job.status === 'error') return;

        if (code !== 0) {
            job.status = 'error';
            job.message = lastErrorLine(stderr);
            return;
        }

        const output = findOutput(job.dir);

        if (!output) {
            job.status = 'error';
            job.message = 'Video file siam a ni lo.';
            return;
        }

        // iPhone-compatible MP4 conversion. Report FFmpeg's actual progress
        // so the phone UI does not appear frozen at 69% during transcoding.
        const baseName = path.parse(output.f).name;
        const mp4Name = baseName + '.mp4';
        const tempPath = path.join(job.dir, baseName + '.iphone-temp.mp4');
        const finalPath = path.join(job.dir, mp4Name);

        job.message = 'iPhone-compatible video convert mek...';
        job.percent = 70;

        const ffmpegArgs = [
            '-hide_banner',
            '-nostats',
            '-y',
            '-i', output.p,
            '-map', '0:v:0',
            '-map', '0:a?',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '23',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
            '-progress', 'pipe:1',
            tempPath
        ];

        const ffmpeg = spawn(FFMPEG_PATH, ffmpegArgs, {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let ffmpegError = '';
        let ffmpegStdoutBuffer = '';
        let ffmpegStderrBuffer = '';
        let durationSeconds = 0;
        let latestTimeSeconds = 0;
        let ffmpegTimedOut = false;

        const parseClockSeconds = value => {
            const m = String(value).match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
            return m ? (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) : 0;
        };

        const refreshConversionProgress = () => {
            if (durationSeconds > 0 && latestTimeSeconds >= 0) {
                const fraction = Math.max(0, Math.min(1, latestTimeSeconds / durationSeconds));
                const converted = Math.round(fraction * 100);
                job.percent = Math.min(90, 70 + Math.round(fraction * 20));
                job.message = `iPhone MP4 convert mek... ${converted}%`;
            } else {
                job.percent = Math.max(70, Math.min(89, job.percent || 70));
                job.message = 'iPhone-compatible MP4 convert mek...';
            }
        };

        ffmpeg.stdout.on('data', data => {
            ffmpegStdoutBuffer += data.toString();
            const lines = ffmpegStdoutBuffer.split(/\r?\n/);
            ffmpegStdoutBuffer = lines.pop() || '';

            for (const line of lines) {
                const eq = line.indexOf('=');
                if (eq < 1) continue;
                const key = line.slice(0, eq).trim();
                const value = line.slice(eq + 1).trim();
                if (key === 'out_time_us' || key === 'out_time_ms') {
                    const micros = Number(value);
                    if (Number.isFinite(micros) && micros >= 0) {
                        latestTimeSeconds = micros / 1000000;
                    }
                    refreshConversionProgress();
                } else if (key === 'out_time') {
                    const seconds = parseClockSeconds(value);
                    if (seconds > 0) latestTimeSeconds = seconds;
                    refreshConversionProgress();
                }
            }
        });

        ffmpeg.stderr.on('data', data => {
            const chunk = data.toString();
            ffmpegError += chunk;
            ffmpegStderrBuffer += chunk;
            const lines = ffmpegStderrBuffer.split(/\r?\n/);
            ffmpegStderrBuffer = lines.pop() || '';
            for (const line of lines) {
                const durationMatch = line.match(/Duration:\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/i);
                if (durationMatch) {
                    durationSeconds = parseClockSeconds(durationMatch[1]);
                    refreshConversionProgress();
                }
            }
        });

        const ffmpegKillTimer = setTimeout(() => {
            ffmpegTimedOut = true;
            try { ffmpeg.kill('SIGKILL'); } catch (_) {}
        }, 20 * 60 * 1000);

        ffmpeg.on('error', error => {
            clearTimeout(ffmpegKillTimer);
            job.status = 'error';
            job.message = 'FFmpeg awm lo: ' + error.message;
            console.error('FFMPEG ERROR:', error.message);
        });

        ffmpeg.on('close', code => {
            clearTimeout(ffmpegKillTimer);
            if (job.status === 'error') return;

            if (ffmpegTimedOut) {
                job.status = 'error';
                job.message = 'iPhone MP4 conversion rei lutuk (20 minutes).';
                try { fs.rmSync(tempPath, { force: true }); } catch (_) {}
                console.error('FFMPEG CONVERSION TIMEOUT');
                return;
            }

            if (
                code !== 0 ||
                !fs.existsSync(tempPath) ||
                fs.statSync(tempPath).size === 0
            ) {
                job.status = 'error';
                job.message = lastErrorLine(ffmpegError) ||
                    'iPhone MP4 conversion a hlawhchham.';
                console.error('FFMPEG CONVERSION ERROR:', ffmpegError);
                try { fs.rmSync(tempPath, { force: true }); } catch (_) {}
                return;
            }

            try {
                fs.renameSync(tempPath, finalPath);

                if (output.p !== finalPath) {
                    fs.rmSync(output.p, { force: true });
                }

                job.status = 'done';
                job.percent = 100;
                job.file = finalPath;
                job.filename = mp4Name;
                job.size = fs.statSync(finalPath).size;
                job.message = 'iPhone-compatible MP4 zo fel e';

            } catch (error) {
                job.status = 'error';
                job.message = 'MP4 save a hlawhchham: ' + error.message;
            }
        });
    });
}

// EXPRESS APP
const app = express();

app.set('trust proxy', true);

app.use(cors({
    origin: true,
    allowedHeaders: ['Content-Type', 'x-api-key'],
    exposedHeaders: ['Content-Length', 'Content-Disposition']
}));

app.use(express.json({ limit: '10kb' }));

// HEALTH CHECK
app.get('/health', (req, res) => {
    res.json({ ok: true });
});

// DOWNLOAD FILE
app.get('/f/:id', (req, res) => {
    const job = jobs.get(req.params.id);

    if (!job || job.status !== 'done' || !fs.existsSync(job.file)) {
        return res.status(404).send('File a awm lo emaw a bo tawh.');
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', job.size);

    res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(job.filename)}`
    );

    fs.createReadStream(job.file).pipe(res);
});

// CREATE DOWNLOAD
app.post('/api/jobs', async (req, res) => {
    try {
        if (rateLimited(req.ip)) {
            return res.status(429).json({
                error: 'A tam lutuk. Hun khat hnuah ti leh rawh.'
            });
        }

        if (runningCount() >= MAX_RUNNING) {
            return res.status(429).json({
                error: 'Server a buai mek. Minute khat hnuah ti leh rawh.'
            });
        }

        const url = await validateUrl(
            String((req.body || {}).url || '').trim()
        );

        const quality = String(
            (req.body || {}).quality || 'HD 720p'
        ).slice(0, 30);

        const id = crypto.randomBytes(18).toString('hex');
        const dir = path.join(WORK_DIR, id);

        fs.mkdirSync(dir, { recursive: true });

        const job = {
            id,
            url,
            quality,
            dir,
            status: 'running',
            percent: 0,
            message: 'Inbuatsaih mek...',
            created: Date.now()
        };

        jobs.set(id, job);
        startJob(job);

        res.json({ id });

    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// CHECK DOWNLOAD PROGRESS
app.get('/api/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);

    if (!job) {
        return res.status(404).json({
            error: 'Job a awm lo.'
        });
    }

    res.json({
        status: job.status,
        percent: job.percent,
        message: job.message,
        filename: job.filename,
        size: job.size
    });
});

// CLEAN OLD FILES
setInterval(() => {
    const now = Date.now();

    for (const [id, job] of jobs) {
        if (now - job.created > TTL_MS && job.status !== 'running') {
            removeJob(id);
        }
    }
}, 60 * 1000);

// CHECK YT-DLP VERSION
function logYtDlpVersion() {
    const process = spawn(YTDLP, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';

    process.stdout.on('data', data => {
        output += data.toString();
    });

    process.stderr.on('data', data => {
        output += data.toString();
    });

    process.on('error', error => {
        console.error('yt-dlp version check failed:', error.message);
    });

    process.on('close', code => {
        console.log('yt-dlp version check exit code:', code);

        if (output.trim()) {
            console.log('yt-dlp version:', output.trim());
        }
    });
}

logYtDlpVersion();

// START SERVER
app.listen(PORT, () => {
    console.log(`Muantemama server running on port ${PORT}`);
});