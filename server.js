// Muantemama Downloader Server
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

const PORT = parseInt(process.env.PORT || '8787', 10);
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const FFMPEG_DIR = process.env.FFMPEG_DIR || '';
const COOKIES_FILE = process.env.COOKIES_FILE || '';
const WORK_DIR = process.env.WORK_DIR || path.join(os.tmpdir(), 'muantemama-jobs');
const MAX_FILESIZE = process.env.MAX_FILESIZE || '1G';
const TTL_MS = 15 * 60 * 1000;
const MAX_RUNNING = parseInt(process.env.MAX_RUNNING || '2', 10);
const JOBS_PER_HOUR = parseInt(process.env.JOBS_PER_HOUR || '30', 10);

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
        throw new Error('http/https link chauh a phal.');
    }

    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host)
        ? [{ address: host }]
        : await dns.lookup(host, { all: true });

    if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) {
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

    const errs = lines.filter(l => /^ERROR:/i.test(l));

    return (
        errs.length
            ? errs[errs.length - 1]
            : (lines[lines.length - 1] || 'Unknown error')
    ).replace(/^ERROR:\s*/i, '');
}

function findOutput(dir) {
    const files = fs.readdirSync(dir)
        .filter(f =>
            /\.(mp4|m4v|mov|webm|mkv|avi|flv)$/i.test(f) &&
            !/\.(part|ytdl|temp|tmp)$/i.test(f) &&
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
    let n = 0;

    for (const j of jobs.values()) {
        if (j.status === 'running') n++;
    }

    return n;
}

function removeJob(id) {
    const j = jobs.get(id);
    if (!j) return;

    try {
        fs.rmSync(j.dir, { recursive: true, force: true });
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
        // Prefer a separate video + audio pair; fall back only to a format
        // that actually contains video. This prevents audio-only files being
        // returned as if they were videos.
        '-f', `bv[height<=${height}]+ba/b[height<=${height}][vcodec!=none]/b[vcodec!=none]`,
        '-S', `res:${height},ext:mp4:m4a`,
        '--merge-output-format', 'mp4',
        '--no-keep-video',
        '--no-playlist',
        '--windows-filenames',
        '--no-mtime',
        '--newline',
        '--retries', '5',
        '--fragment-retries', '5',
        '--socket-timeout', '30',
        '--max-filesize', MAX_FILESIZE,
        '--js-runtimes', 'node',
        '--remote-components', 'ejs:github',
        '--extractor-args', 'youtube:player_client=web,mweb,tv',
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
    let buf = '';

    const onLine = (line) => {
        line = line.replace(/\x1B\[[0-9;]*m/g, '').trim();

        const m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);

        if (m) {
            job.percent = Math.min(99, parseFloat(m[1]));
            job.message = 'Downloading...';
        } else if (/\[Merger\]|\[VideoRemuxer\]/i.test(line)) {
            job.percent = 99;
            job.message = 'Video leh audio pawlh mek...';
        }
    };

    proc.stdout.on('data', d => {
        buf += d.toString();
        const parts = buf.split(/\r|\n/);
        buf = parts.pop();
        parts.forEach(onLine);
    });

    proc.stderr.on('data', d => {
        const msg = d.toString();
        stderr += msg;
        console.error('YT-DLP ERROR:', msg);
    });

    const killTimer = setTimeout(() => {
        try {
            proc.kill('SIGKILL');
        } catch (_) {}
    }, 20 * 60 * 1000);

    proc.on('error', e => {
        clearTimeout(killTimer);
        job.status = 'error';
        job.message = 'yt-dlp run theih a ni lo: ' + e.message;
        console.error('YT-DLP SPAWN ERROR:', e.message);
    });

    proc.on('close', code => {
        clearTimeout(killTimer);

        console.error('YT-DLP EXIT CODE:', code);

        if (job.status === 'error') return;

        if (code === 0) {
            const out = findOutput(job.dir);

            if (out) {
                job.status = 'done';
                job.percent = 100;
                job.file = out.p;
                job.filename = out.f;
                job.size = out.size;
                job.message = 'Zo fel e';
                return;
            }

            job.status = 'error';
            job.message = 'Video file siam a ni lo.';
        } else {
            job.status = 'error';
            job.message = lastErrorLine(stderr);
        }
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

app.get('/health', (req, res) => {
    res.json({ ok: true });
});

// FILE DOWNLOAD
app.get('/f/:id', (req, res) => {
    const job = jobs.get(req.params.id);

    if (!job || job.status !== 'done' || !fs.existsSync(job.file)) {
        return res.status(404).send('File a awm lo emaw a bo tawh.');
    }

    const ext = path.extname(job.filename || job.file).toLowerCase();
    const mimeTypes = {
        '.mp4': 'video/mp4',
        '.m4v': 'video/x-m4v',
        '.mov': 'video/quicktime',
        '.webm': 'video/webm',
        '.mkv': 'video/x-matroska',
        '.avi': 'video/x-msvideo',
        '.flv': 'video/x-flv'
    };
    res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
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

    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// CHECK PROGRESS
app.get('/api/jobs/:id', (req, res) => {
    const j = jobs.get(req.params.id);

    if (!j) {
        return res.status(404).json({
            error: 'Job a awm lo.'
        });
    }

    res.json({
        status: j.status,
        percent: j.percent,
        message: j.message,
        filename: j.filename,
        size: j.size
    });
});

// CLEAN OLD FILES
setInterval(() => {
    const now = Date.now();

    for (const [id, j] of jobs) {
        if (now - j.created > TTL_MS && j.status !== 'running') {
            removeJob(id);
        }
    }
}, 60 * 1000);

// LOG YT-DLP VERSION
// Update yt-dlp in the Render Build Command, not with `yt-dlp -U`
// because pip-managed installations cannot self-update with that command.
function logYtDlpVersion() {
    const p = spawn(YTDLP, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    p.stdout.on('data', d => { output += d.toString(); });
    p.stderr.on('data', d => { output += d.toString(); });
    p.on('error', e => {
        console.error('yt-dlp version check failed:', e.message);
    });
    p.on('close', code => {
        console.log('yt-dlp version check exit code:', code);
        if (output.trim()) console.log('yt-dlp version:', output.trim());
    });
}

logYtDlpVersion();

// START SERVER
app.listen(PORT, () => {
    console.log(`Muantemama server running on port ${PORT}`);
});
