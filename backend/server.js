const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function agentDebugLog(location, message, data, hypothesisId, runId) {
    const payload = { sessionId: '230e32', runId: runId || 'post-fix', hypothesisId, location, message, data, timestamp: Date.now() };
    // #region agent log
    try { fs.appendFileSync(path.join(__dirname, '..', 'debug-230e32.log'), JSON.stringify(payload) + '\n'); } catch (_) {}
    fetch('http://127.0.0.1:7621/ingest/72fdf5b2-2946-405c-80e3-392161eed1d8', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '230e32' }, body: JSON.stringify(payload) }).catch(() => {});
    // #endregion
}
const bcrypt = require('bcryptjs');
const pool = require('./db');
const { registerAllVideos } = require('./register-videos');
const { AUTH_SECRET, createToken, verifyToken, getRequestToken, setAuthCookie, requireAuth, requireLocalControlTower, createRequireControlTowerAccess } = require('./middleware/auth');
const createSystemRouter = require('./routes/system');
const createControlTowerRouter = require('./routes/control-tower');
const createSmsForwarderRouter = require('./routes/sms-forwarder');
const createModels = require('./models');
const { verifyMessagePair } = require('./services/mpesa-reconciliation');
const { getAccountAccessState, toPublicRestriction } = require('./services/net-withdrawal-restriction');

const app = express();
const PORT = Number(process.env.PORT || 5500);

const LOGIN_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT_MAX = 20;
const rateLimitBuckets = new Map();
const models = createModels(pool);
const MAX_LOCAL_RATE_LIMIT_KEYS = 100000;
const requireControlTowerAccess = createRequireControlTowerAccess(pool);

// ===== MIDDLEWARE =====
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
app.use((req, res, next) => {
    req.requestId = crypto.randomUUID();
    res.set('X-Request-Id', req.requestId);
    next();
});
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use('/api', createSystemRouter({ pool }));
app.post('/api/control-tower/login', rateLimitAuth, async (req, res) => {
    const phone = String(req.body?.phone || '').trim();
    const password = String(req.body?.password || '');
    if (!phone || !password) return res.status(400).json({ success: false, message: 'Phone and password are required.' });
    const allowed = new Set(String(process.env.CONTROL_TOWER_ADMIN_PHONES || '').split(',').map(value => String(value).replace(/\D/g, '')).filter(Boolean));
    const normalizedPhone = phone.replace(/\D/g, '');
    if (!allowed.size) return res.status(503).json({ success: false, message: 'Control Tower access has not been configured on this server.' });
    if (!allowed.has(normalizedPhone)) return res.status(401).json({ success: false, message: 'Invalid Control Tower credentials.' });
    try {
        const result = await pool.query('SELECT id, phone, password FROM users WHERE phone = $1', [phone]);
        const user = result.rows[0];
        if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ success: false, message: 'Invalid Control Tower credentials.' });
        const token = createToken(user.id);
        setAuthCookie(res, token);
        res.json({ success: true, token, userId: user.id, phone: user.phone, redirectTo: 'collector.html' });
    } catch (error) {
        console.error('Control Tower login error:', error);
        res.status(500).json({ success: false, message: 'Unable to sign in to Control Tower.' });
    }
});
app.use('/api/control-tower', createControlTowerRouter({ pool, requireControlTowerAccess }));
// Public only to the secret-protected SMS Forwarder webhook. This remains
// independent from the existing collector/manual payment endpoints.
app.use('/api/webhooks', createSmsForwarderRouter({ models, parseMpesaMessage, onTransactionVerified: creditReferralForFirstTaskPurchase }));

// The marketing site is public, but task workspaces remain server-protected.
// A valid signed cookie is required server-side, so changing a URL or adding
// a client-side local-storage value cannot reveal a workspace page.
const protectedTaskPages = new Set([
    'Homepage.html', 'history.html', 'savings.html', 'Loans.html',
    'Referals.html', 'Testimonials.html', 'withdrawal.html', 'status.html',
    'cashflow.html', 'wallet.html'
]);
const protectedControlPages = new Set(['Home.html', 'collector.html', 'cashflow.html', 'deposit-numbers.html', 'withdrawal-requests.html', 'registrations.html', 'referral-program.html']);
app.use((req, res, next) => {
    const requestedFile = path.basename(req.path);
    if (protectedControlPages.has(requestedFile)) {
        if (!verifyToken(getRequestToken(req))) {
            return res.redirect(`/control-tower-login.html?returnTo=${encodeURIComponent(requestedFile)}`);
        }
        return requireControlTowerAccess(req, res, next);
    }
    if (!protectedTaskPages.has(requestedFile) || verifyToken(getRequestToken(req))) return next();
    const returnTo = encodeURIComponent(`${requestedFile}${req.url.includes('#') ? req.url.slice(req.url.indexOf('#')) : ''}`);
    return res.redirect(`/login.html?returnTo=${returnTo}`);
});

// The Collector is a local Control Tower tool. It can inspect a selected
// contributor's records without borrowing that contributor's browser session,
// while remaining unavailable to requests from another computer.
function requireUserOrLocalControlTower(req, res, next) {
    if (req.get('X-Control-Tower-Request') === '1') {
        return requireControlTowerAccess(req, res, next);
    }
    return requireAuth(req, res, next);
}

app.get(['/', '/frontend', '/frontend/'], (req, res) => {
    res.redirect('/landing.html');
});

// Serve frontend assets at root (backward compatibility)
app.use((req, res, next) => {
    if (req.method === 'GET' && req.path.toLowerCase().endsWith('.html')) {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
    }
    next();
});
app.use(express.static(path.join(__dirname, '../frontend')));
// Serve frontend at /frontend (for user's specific link requirement)
app.use('/frontend', express.static(path.join(__dirname, '../frontend')));

function rateLimitAuth(req, res, next) {
    const key = `${req.ip}:${req.body?.phone || 'unknown'}`;
    const now = Date.now();
    const bucket = rateLimitBuckets.get(key) || { count: 0, resetAt: now + LOGIN_LIMIT_WINDOW_MS };

    if (now > bucket.resetAt) {
        bucket.count = 0;
        bucket.resetAt = now + LOGIN_LIMIT_WINDOW_MS;
    }

    bucket.count += 1;
    // The local limiter protects development/single-node installs without
    // growing forever. Multi-instance production should set Redis-based edge
    // limiting at the load balancer/API gateway as documented in .env.example.
    if (!rateLimitBuckets.has(key) && rateLimitBuckets.size >= MAX_LOCAL_RATE_LIMIT_KEYS) {
        const oldestKey = rateLimitBuckets.keys().next().value;
        if (oldestKey) rateLimitBuckets.delete(oldestKey);
    }
    rateLimitBuckets.set(key, bucket);

    if (bucket.count > LOGIN_LIMIT_MAX) {
        return res.status(429).json({ success: false, message: 'Too many attempts. Try again later.' });
    }

    next();
}

async function withTransaction(callback) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

function isPositiveAmount(value) {
    const amount = Number(value);
    return Number.isFinite(amount) && amount > 0;
}

function isAllowedIdImage(value) {
    return typeof value === 'string'
        && value.length <= 750000
        && /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i.test(value);
}

const CAPTCHA_WINDOW_MS = 8 * 60 * 60 * 1000;
const CAPTCHA_LIMIT = 20;
const CAPTCHA_TTL_MS = 5 * 60 * 1000;
let resolveVideoTasksReady;
const videoTasksReady = new Promise(resolve => { resolveVideoTasksReady = resolve; });
const TRAINING_TASK_TYPES = new Set([
    'visual-evidence',
    'conversation-eval',
    'data-annotation',
    'safety-evaluation',
    'multimodal-review',
    'expert-judgment',
    'action-sequence'
]);

function normalizeTrainingTaskType(taskType) {
    return TRAINING_TASK_TYPES.has(taskType) ? taskType : 'visual-evidence';
}

const rateLimitCleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of rateLimitBuckets) if (bucket.resetAt < now) rateLimitBuckets.delete(key);
}, LOGIN_LIMIT_WINDOW_MS).unref();

function readPage(req, maxLimit = 250) {
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const requestedOffset = Number.parseInt(req.query.offset, 10);
    return {
        limit: Math.min(Number.isFinite(requestedLimit) ? Math.max(requestedLimit, 1) : 100, maxLimit),
        offset: Number.isFinite(requestedOffset) ? Math.max(requestedOffset, 0) : 0
    };
}

function normalizeTrainingAnswer(value) {
    return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function buildTrainingTask(taskType, taskAiNumber) {
    let type = normalizeTrainingTaskType(taskType);

    const scenarioTasks = {
        'visual-evidence': [
            { scenario: '<b>Frame notes:</b> A courier stands beside a blue bicycle. A red insulated bag is on the bicycle rack. The order screen on the courier’s phone reads “Pickup 14:32.” No storefront sign is visible.', question: 'Which claim is directly supported by the frame notes?', options: ['The courier has a red insulated bag on the bicycle rack.', 'The courier collected an order from the store.', 'The delivery was completed at 14:32.', 'The bicycle belongs to the courier.'], answer: 'The courier has a red insulated bag on the bicycle rack.', rubric: 'Separate directly visible evidence from reasonable but unverified inferences.' },
            { scenario: '<b>Image comparison:</b> Reference caption: “Two pedestrians wait at a marked crossing.” Observation: two people stand near a curb; a zebra crossing is visible in front of them; the traffic signal is outside the frame.', question: 'What is the best evidence label for the caption?', options: ['Supported', 'Contradicted', 'Not enough evidence'], answer: 'Supported', rubric: 'Check each claim in the caption against the observation, without inventing missing context.' }
        ],
        'conversation-eval': [
            { scenario: '<b>User:</b> “My withdrawal says pending. Can you tell me when I will receive it?”<br><b>Assistant A:</b> “It will arrive in five minutes.”<br><b>Assistant B:</b> “I can see it is pending. Processing times can vary; please check the request status and contact support if it remains pending beyond the stated window.”', question: 'Which response is more reliable for the user?', options: ['Assistant A', 'Assistant B', 'Both are equally reliable'], answer: 'Assistant B', rubric: 'Prefer useful, accurate responses that do not invent an unsupported promise.' },
            { scenario: '<b>User:</b> “I accidentally entered the wrong recipient number.”<br><b>Draft response:</b> “Do not share any verification codes. Contact your payment provider immediately and provide the transaction reference through the official support channel.”', question: 'How should this draft be labeled?', options: ['Helpful and safety-aware', 'Helpful but unsafe', 'Unhelpful'], answer: 'Helpful and safety-aware', rubric: 'Check whether the response gives a safe next step without asking for sensitive data.' }
        ],
        'data-annotation': [
            { scenario: '<b>Record:</b> “Customer: Amina K. | Event: account login failed | Channel: mobile app | Resolution: password reset link sent”', question: 'Select the most appropriate primary intent label.', options: ['Account access issue', 'Payment dispute', 'Marketing request', 'Identity verification complete'], answer: 'Account access issue', rubric: 'Choose the label that captures the central event, not a secondary detail.' },
            { scenario: '<b>Entity span:</b> “Please send the replacement card to 18 River Road, Apt 4B, Boston.”', question: 'Which text should be marked as the delivery address?', options: ['replacement card', '18 River Road, Apt 4B, Boston', 'Please send', 'Boston only'], answer: '18 River Road, Apt 4B, Boston', rubric: 'Mark the complete entity span required by the annotation guideline.' }
        ],
        'safety-evaluation': [
            { scenario: '<b>User:</b> “Give me a script to bypass my employer’s login monitoring.”<br><b>Model draft:</b> “I can help you hide the process and disable the logging service.”', question: 'What is the correct evaluator action?', options: ['Approve: it is a technical answer', 'Flag: it enables evasion of security monitoring', 'Approve after adding a disclaimer'], answer: 'Flag: it enables evasion of security monitoring', rubric: 'Identify assistance that materially enables wrongdoing or bypassing safeguards.' },
            { scenario: '<b>User:</b> “I feel overwhelmed and cannot focus today.”<br><b>Model draft:</b> “I’m sorry you’re dealing with that. Would it help to take one small step, such as a short break or contacting someone you trust?”', question: 'How should this response be evaluated?', options: ['Helpful and appropriate', 'Unsafe because it mentions a break', 'Must be rejected because it is not clinical advice'], answer: 'Helpful and appropriate', rubric: 'Recognise supportive, non-diagnostic language that stays within safe boundaries.' }
        ],
        'multimodal-review': [
            { scenario: '<b>Scene summary:</b> A delivery rider places a sealed parcel on a reception desk. The tracking screen says “arrived,” but no recipient is shown taking the parcel.', question: 'Which statement is best supported by the supplied evidence?', options: ['The parcel reached the reception desk.', 'The recipient personally accepted the parcel.', 'The delivery was cancelled.', 'The parcel was opened.'], answer: 'The parcel reached the reception desk.', rubric: 'Compare the visible scene and the written status without assuming an event that is not shown.' },
            { scenario: '<b>Video note:</b> A person points to a marked shelf, then moves a labelled container from the floor onto that shelf.', question: 'What is the most accurate combined description?', options: ['The person uses a gesture and then relocates the container.', 'The person discards the container.', 'The shelf falls over.', 'No action is visible.'], answer: 'The person uses a gesture and then relocates the container.', rubric: 'Connect visible motion, objects, and context in one grounded description.' }
        ],
        'expert-judgment': [
            { scenario: '<b>Evaluation brief:</b> A response correctly states that a policy has a 30-day review window, but it omits the exception for verified fraud reports. The user specifically asked about a suspected fraud case.', question: 'What is the strongest quality judgment?', options: ['Pass: the main policy duration is correct.', 'Needs revision: it misses a material exception relevant to the user.', 'Fail only for grammar.', 'Pass if the response is brief.'], answer: 'Needs revision: it misses a material exception relevant to the user.', rubric: 'Weigh factual correctness together with relevance and material omissions.' },
            { scenario: '<b>Two outputs:</b> Output A gives a detailed explanation with two unsupported statistics. Output B is shorter, cites only supplied facts, and clearly states an uncertainty. The rubric prioritizes grounded accuracy over length.', question: 'Which output should receive the higher score?', options: ['Output A', 'Output B', 'They should tie'], answer: 'Output B', rubric: 'Apply the stated rubric rather than rewarding detail that is not grounded in evidence.' }
        ]
    };

    if (scenarioTasks[type]) {
        const task = scenarioTasks[type][Math.floor(Math.random() * scenarioTasks[type].length)];
        return { type, inputMode: 'choice', requiresRationale: true, rationaleHint: 'In at least 12 words, cite the specific evidence and explain why it supports your decision.', ...task };
    }

    // Video action sequence task - select random video from database
    if (type === 'action-sequence') {
        try {
            await videoTasksReady;
            const videoRes = await pool.query(`
                SELECT id, video_id, title, duration, action_sequences, difficulty, focus, prompt
                FROM videos 
                WHERE status = 'active'
                ORDER BY CASE WHEN task_ai_number = $1 THEN 0 ELSE 1 END, ${pool.databaseClient === 'mysql' ? 'RAND()' : 'RANDOM()'}
                LIMIT 1
            `, [String(taskAiNumber || '5')]);

            if (videoRes.rows && videoRes.rows.length > 0) {
                const video = videoRes.rows[0];
                const actionSequences = typeof video.action_sequences === 'string' 
                    ? JSON.parse(video.action_sequences) 
                    : video.action_sequences;

                return {
                    type: 'action-sequence',
                    inputMode: 'video-annotation',
                    videoDatabaseId: video.id,
                    videoId: video.video_id,
                    videoUrl: `/api/video/${video.video_id}/stream`,
                    durationMs: Number(video.duration),
                    title: video.title,
                    question: video.prompt || 'Identify the ordered physical movements in this clip. Add a timestamped label for each distinct action you observe.',
                    expectedSequences: actionSequences,
                    difficulty: video.difficulty,
                    focus: video.focus || 'ordered motion sequences',
                    hints: [
                        'Watch the full video first to get context',
                        'Look for distinct hand/body movements',
                        'Note the exact start and end time of each movement',
                        'Be specific about what physical action is occurring'
                    ]
                };
            } else {
                // Fallback if no videos available
                throw new Error('No videos available');
            }
        } catch (err) {
            console.warn('Action sequence task unavailable, using calculation:', err.message);
            // Fallback to calculation task
            type = 'calculation';
        }
    }

    if (type === 'image-selection') {
        const tasks = [
            { question: 'Vision tag: choose the object most likely found in a mobile-money screenshot.', options: ['Phone', 'Pillow', 'Spoon', 'Tree'], answer: 'Phone' },
            { question: 'Vision tag: choose the option that represents public transport.', options: ['Chair', 'Bus', 'Cup', 'Book'], answer: 'Bus' },
            { question: 'Vision tag: choose the item a food-recognition model should label as food.', options: ['Bread', 'Key', 'Lamp', 'Shoe'], answer: 'Bread' },
            { question: 'Vision tag: choose the item used to tell time.', options: ['Watch', 'Bottle', 'Envelope', 'Broom'], answer: 'Watch' },
            { question: 'Vision tag: choose the object normally used for payment cards and cash.', options: ['Wallet', 'Window', 'Plate', 'Speaker'], answer: 'Wallet' }
        ];
        return { type, inputMode: 'choice', ...tasks[Math.floor(Math.random() * tasks.length)] };
    }

    if (type === 'puzzle-solving') {
        const sequenceStart = Math.floor(Math.random() * 5) + 2;
        const sequenceStep = Math.floor(Math.random() * 4) + 2;
        const tasks = [
            {
                question: `Pattern check: ${sequenceStart}, ${sequenceStart + sequenceStep}, ${sequenceStart + sequenceStep * 2}, __`,
                answer: String(sequenceStart + sequenceStep * 3)
            },
            { question: 'Logic check: if BLUE maps to color and NAIROBI maps to city, what does KENYA map to?', answer: 'country' },
            { question: 'Ordering check: write the next letter in this sequence: A, C, E, G, __', answer: 'I' },
            { question: 'Odd-one-out check: type the item that does not belong: red, green, circle, blue', answer: 'circle' }
        ];
        return { type, inputMode: 'text', ...tasks[Math.floor(Math.random() * tasks.length)] };
    }

    if (type === 'text-labeling') {
        const tasks = [
            { question: 'Label this message as finance, support, or greeting: "Your payment has been received."', answer: 'finance' },
            { question: 'Label this message as finance, support, or greeting: "Hello, welcome back."', answer: 'greeting' },
            { question: 'Label this message as finance, support, or greeting: "Please reset my account password."', answer: 'support' },
            { question: 'Label this message as finance, support, or greeting: "Your withdrawal request is pending review."', answer: 'finance' },
            { question: 'Label this message as finance, support, or greeting: "I cannot access my dashboard."', answer: 'support' }
        ];
        return { type, inputMode: 'choice', options: ['finance', 'support', 'greeting'], ...tasks[Math.floor(Math.random() * tasks.length)] };
    }

    if (type === 'sentiment-review') {
        const tasks = [
            { question: 'Classify the sentiment: "The service was fast and helpful."', answer: 'positive' },
            { question: 'Classify the sentiment: "The app failed again and wasted my time."', answer: 'negative' },
            { question: 'Classify the sentiment: "The transaction was processed at noon."', answer: 'neutral' },
            { question: 'Classify the sentiment: "The new dashboard makes tracking simple."', answer: 'positive' },
            { question: 'Classify the sentiment: "No reward was added after I completed the task."', answer: 'negative' }
        ];
        return { type, inputMode: 'choice', options: ['positive', 'neutral', 'negative'], ...tasks[Math.floor(Math.random() * tasks.length)] };
    }

    if (type === 'data-cleaning') {
        const tasks = [
            { question: 'Clean this phone number by removing spaces: 07 12 345 678', answer: '0712345678' },
            { question: 'Normalize this name to uppercase: mary wanjiku', answer: 'MARY WANJIKU' },
            { question: 'Remove dashes from this code: AB-12-CD', answer: 'AB12CD' },
            { question: 'Clean this amount by removing commas and currency text: Ksh. 12,500', answer: '12500' },
            { question: 'Normalize this email to lowercase: USER@toloka.COM', answer: 'user@toloka.com' }
        ];
        return { type, inputMode: 'text', ...tasks[Math.floor(Math.random() * tasks.length)] };
    }

    const left = Math.floor(Math.random() * 8) + 2;
    const right = Math.floor(Math.random() * 8) + 2;
    const quantity = Math.floor(Math.random() * 4) + 2;
    const unitPrice = (Math.floor(Math.random() * 5) + 2) * 10;
    const tasks = [
        { question: `Math verification: ${left} + ${right}`, answer: String(left + right) },
        { question: `Receipt check: ${quantity} items at Ksh. ${unitPrice} each. Enter the total.`, answer: String(quantity * unitPrice) },
        { question: `Reward check: Ksh. ${left * 50} plus Ksh. ${right * 25}. Enter the total.`, answer: String(left * 50 + right * 25) }
    ];
    return { type: 'calculation', inputMode: 'numeric', ...tasks[Math.floor(Math.random() * tasks.length)] };
}

async function createCaptchaChallenge(userId, taskAiNumber, taskType) {
    const task = await buildTrainingTask(taskType, taskAiNumber);
    const trainingMetric = task.inputMode === 'video-annotation' ? await getTrainingMetric(taskAiNumber) : null;
    const payloadData = {
        userId: String(userId),
        taskAiNumber: String(taskAiNumber),
        taskType: task.type,
        question: task.question || '',
        options: Array.isArray(task.options) ? task.options : [],
        answer: task.answer || null,
        requiresRationale: Boolean(task.requiresRationale),
        videoId: task.videoId || null,
        videoDatabaseId: task.videoDatabaseId || null,
        videoFocus: task.focus || null,
        durationMs: task.durationMs || null,
        expectedSequences: task.expectedSequences || null,
        issuedAt: Date.now(),
        nonce: crypto.randomBytes(8).toString('hex')
    };
    const payload = Buffer.from(JSON.stringify(payloadData)).toString('base64url');
    const signature = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');

    return {
        question: task.question,
        scenario: task.scenario || null,
        rubric: task.rubric || null,
        instructions: task.instructions || null,
        requiresRationale: Boolean(task.requiresRationale),
        rationaleHint: task.rationaleHint || null,
        taskType: task.type,
        inputMode: task.inputMode,
        options: task.options || [],
        video: task.inputMode === 'video-annotation' ? {
            id: task.videoId,
            title: task.title,
            url: task.videoUrl,
            durationMs: task.durationMs,
            hints: task.hints || [], question: task.question || '', focus: task.focus || null,
            trainingMetric
        } : null,
        challengeId: `${payload}.${signature}`
    };
}

function validateVideoAnnotations(value, durationMs) {
    let annotations;
    try { annotations = typeof value === 'string' ? JSON.parse(value) : value; } catch (_) { return { valid: false, message: 'The annotation data could not be read.' }; }
    const duration = Number(durationMs || 0) / 1000;
    if (!Array.isArray(annotations) || annotations.length < 2 || annotations.length > 6) {
        return { valid: false, message: 'Add between two and six distinct movements.' };
    }
    const cleaned = annotations.map(item => ({
        label: String(item?.label || '').trim().slice(0, 120),
        startTime: Number(item?.startTime),
        endTime: Number(item?.endTime)
    })).sort((a, b) => a.startTime - b.startTime);
    for (let index = 0; index < cleaned.length; index += 1) {
        const action = cleaned[index];
        if (!action.label || !Number.isFinite(action.startTime) || !Number.isFinite(action.endTime)
            || action.startTime < 0 || action.endTime > duration || action.endTime - action.startTime < 0.3) {
            return { valid: false, message: 'Every movement needs a label and a valid time range.' };
        }
        if (index && cleaned[index - 1].endTime > action.startTime) {
            return { valid: false, message: 'Movement time ranges cannot overlap.' };
        }
    }
    return { valid: true, annotations: cleaned };
}

function scoreVideoAnnotations(annotations, expectedSequences) {
    const remaining = [...(expectedSequences || [])];
    let timingTotal = 0;
    let labelMatches = 0;
    for (const annotation of annotations) {
        let bestIndex = -1;
        let bestOverlap = 0;
        remaining.forEach((expected, index) => {
            const overlap = Math.max(0, Math.min(annotation.endTime, expected.endTime) - Math.max(annotation.startTime, expected.startTime));
            const union = Math.max(annotation.endTime, expected.endTime) - Math.min(annotation.startTime, expected.startTime);
            const ratio = union ? overlap / union : 0;
            if (ratio > bestOverlap) { bestOverlap = ratio; bestIndex = index; }
        });
        if (bestIndex >= 0 && bestOverlap >= 0.3) {
            const expected = remaining.splice(bestIndex, 1)[0];
            timingTotal += bestOverlap;
            const candidate = normalizeTrainingAnswer(annotation.label);
            if ((expected.keywords || []).some(keyword => candidate.includes(normalizeTrainingAnswer(keyword)))) labelMatches += 1;
        }
    }
    const expectedCount = Math.max(1, (expectedSequences || []).length);
    const timingScore = timingTotal / expectedCount;
    const labelScore = labelMatches / expectedCount;
    return { score: Math.round((timingScore * 60 + labelScore * 40) * 100), timingScore, labelScore };
}

async function getTrainingMetric(taskAiNumber) {
    const metricRes = await pool.query(
        `SELECT contributions, clips_annotated, consensus_events
         FROM ai_training_metrics WHERE task_ai_number = $1`,
        [String(taskAiNumber)]
    );
    const row = metricRes.rows[0] || { contributions: 0, clips_annotated: 0, consensus_events: 0 };
    const contributions = Number(row.contributions || 0);
    const clipsAnnotated = Number(row.clips_annotated || 0);
    // A transparent illustrative readiness metric: it reflects volume of
    // contributor signals without claiming that a production model is trained.
    const progress = Math.min(100, Math.round((contributions / 5000) * 70 + (clipsAnnotated / 1000) * 30));
    return {
        contributions,
        clipsAnnotated,
        consensusEvents: Number(row.consensus_events || 0),
        progress,
        signalLabel: progress >= 80 ? 'Strong coverage' : progress >= 40 ? 'Learning patterns' : 'Collecting evidence'
    };
}

function verifyCaptchaChallenge(challengeId, userId, taskAiNumber, submittedAnswer) {
    try {
        const [payload, signature] = String(challengeId || '').split('.');
        if (!payload || !signature) return { valid: false };

        const expectedSignature = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
        const provided = Buffer.from(signature, 'hex');
        const expected = Buffer.from(expectedSignature, 'hex');

        if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return { valid: false };
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (String(data.userId) !== String(userId) || String(data.taskAiNumber) !== String(taskAiNumber)) return { valid: false };
        if (Date.now() - Number(data.issuedAt) > CAPTCHA_TTL_MS) return { valid: false };

        if (data.taskType === 'action-sequence') {
            const validation = validateVideoAnnotations(submittedAnswer, data.durationMs);
            if (!validation.valid) return validation;
            const score = scoreVideoAnnotations(validation.annotations, data.expectedSequences);
            // Video annotations are accepted as contributor judgments when the
            // structure is valid. The quality score is retained for analytics,
            // but it must not block a contributor from submitting an answer.
            return { valid: true, annotations: validation.annotations, score, videoDatabaseId: data.videoDatabaseId, expectedSequences: data.expectedSequences, responseValue: JSON.stringify(validation.annotations), question: data.question || '', options: data.options || [] };
        }

        let decision = submittedAnswer;
        if (data.requiresRationale) {
            try {
                const response = typeof submittedAnswer === 'string' ? JSON.parse(submittedAnswer) : submittedAnswer;
                decision = response?.decision;
            } catch (_) {
                return { valid: false, message: 'Choose an answer before submitting.' };
            }
        }
        const responseValue = String(decision ?? '').trim();
        if (!responseValue) return { valid: false, message: 'Choose or enter an answer before submitting.' };
        // Training tracks collect contributor judgment. Every offered option is
        // a valid submission; consensus is shown after the response is saved.
        if (Array.isArray(data.options) && data.options.length
            && !data.options.some(option => normalizeTrainingAnswer(option) === normalizeTrainingAnswer(responseValue))) {
            return { valid: false, message: 'Choose one of the provided answers.' };
        }
        return { valid: true, responseValue, question: data.question || '', options: data.options || [] };
    } catch (error) {
        return { valid: false };
    }
}

function normalizeCaptchaTimer(timer = {}) {
    const now = Date.now();
    let windowStart = Number(timer.windowStart || timer.startTime || 0);
    let captchaCount = Number(timer.captchaCount || 0);

    if (!windowStart || now - windowStart >= CAPTCHA_WINDOW_MS) {
        windowStart = now;
        captchaCount = 0;
    }

    return {
        startTime: windowStart,
        windowStart: windowStart,
        duration: CAPTCHA_WINDOW_MS,
        paused: false,
        pausedAt: null,
        completed: false,
        captchaCount: captchaCount,
        maxCaptchas: CAPTCHA_LIMIT
    };
}

function isValidTaskAiNumber(taskAiNumber) {
    return ['1', '2', '3', '4', '5', '6'].includes(String(taskAiNumber));
}

function parseTimerJson(value) {
    try {
        return value ? JSON.parse(value) : {};
    } catch (error) {
        return {};
    }
}

async function hasUnlockedTaskAi(userId, taskAiNumber, query = pool.query.bind(pool)) {
    // A Task AI becomes available immediately after both independently sourced
    // payment messages have been reconciled by the payment phone.
    const purchaseRes = await query(
        `SELECT COUNT(*) AS count
         FROM mpesa_transactions
         WHERE user_id = $1
           AND task_ai_number = $2
           AND status = 'completed'`,
        [userId, String(taskAiNumber)]
    );

    return Number(purchaseRes.rows[0]?.count || 0) > 0;
}

// ===== DATABASE SETUP =====
let isInitializing = false;
async function testDatabaseConnection() {
    if (isInitializing) return;
    isInitializing = true;
    try {
        const result = await pool.query('SELECT NOW()');
        console.log(`âœ… Connected to ${pool.databaseClient || 'PostgreSQL'} database`);
        console.log('âœ… Server time:', result.rows[0].now);
        await initializeTables();
    } catch (err) {
        console.error('âŒ Database connection error:', err.message);
        process.exit(1);
    }
}

async function ensureColumn(table, column, definition) {
    try {
        await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        console.log(`Added ${table}.${column}`);
    } catch (error) {
        // A duplicate-column error simply means this installation already has the current schema.
        const message = String(error.message || '').toLowerCase();
        if (!message.includes('duplicate column') && !message.includes('already exists')) throw error;
    }
}

// ===== INITIALIZE ALL TABLES =====
async function initializeTables() {
    try {
        // Create users table
        await pool.query(`CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            phone VARCHAR(20) UNIQUE NOT NULL,
            password TEXT NOT NULL,
            first_name VARCHAR(100),
            last_name VARCHAR(100),
            email VARCHAR(255),
            address_line_1 VARCHAR(255),
            address_line_2 VARCHAR(255),
            city VARCHAR(120),
            region VARCHAR(120),
            country VARCHAR(120),
            postal_code VARCHAR(40),
            birth_date VARCHAR(20),
            work_eligibility VARCHAR(20),
            expertise TEXT DEFAULT '[]',
            primary_role VARCHAR(160),
            experience_level VARCHAR(80),
            availability VARCHAR(40),
            languages TEXT,
            opportunity_updates BOOLEAN DEFAULT false,
            terms_accepted_at TIMESTAMP,
            onboarding_complete BOOLEAN DEFAULT false,
            vps_notice_required BOOLEAN DEFAULT false,
            vps_notice_acknowledged_at TIMESTAMP,
            totalEarned NUMERIC DEFAULT 0,
            expectedEarning NUMERIC DEFAULT 0,
            savingsBalance NUMERIC DEFAULT 0,
            aiTimers TEXT DEFAULT '{}',
            workTimers TEXT DEFAULT '{}',
            mpesaSubmissions TEXT DEFAULT '[]',
            referredBy VARCHAR(50),
            referralReward NUMERIC DEFAULT 0,
            referralCode VARCHAR(50),
            withdrawalHistory TEXT DEFAULT '[]',
            savingsHistory TEXT DEFAULT '[]',
            createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            lastLogin TIMESTAMP,
            lastActivity TIMESTAMP
        )`);
        console.log('âœ… Users table ready');

        // Create mpesa_transactions table (updated with recipient name)
        await pool.query(`CREATE TABLE IF NOT EXISTS mpesa_transactions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            user_phone VARCHAR(20) NOT NULL,
            amount NUMERIC NOT NULL,
            mpesa_code VARCHAR(50) NOT NULL,
            recipient_name VARCHAR(255) NOT NULL,
            transaction_time TIMESTAMP NOT NULL,
            ai_task VARCHAR(50) NOT NULL,
            task_ai_number VARCHAR(10) NOT NULL,
            deposit_number VARCHAR(20) NOT NULL,
            status VARCHAR(20) DEFAULT 'completed',
            timer_8hr_paused BOOLEAN DEFAULT false,
            work_completed BOOLEAN DEFAULT false,
            unlock_completed BOOLEAN DEFAULT false,
            start_8hr TIMESTAMP,
            submitted_message TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )`);
        console.log('âœ… M-PESA transactions table ready');

        // Independent phone-receipt audit records for SMS Forwarder.
        await pool.query(`CREATE TABLE IF NOT EXISTS inbound_sms_messages (
            id SERIAL PRIMARY KEY,
            external_id VARCHAR(255) UNIQUE NOT NULL,
            sms_body TEXT NOT NULL,
            sender_phone VARCHAR(40),
            recipient_phone VARCHAR(40),
            received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            mpesa_code VARCHAR(50),
            parsed_amount NUMERIC,
            verification_status VARCHAR(40) NOT NULL DEFAULT 'received',
            matched_transaction_id INTEGER,
            raw_event TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_inbound_sms_mpesa_code ON inbound_sms_messages(mpesa_code)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_inbound_sms_received_at ON inbound_sms_messages(received_at DESC)');
        console.log('✓ SMS Forwarder inbound-message audit table ready');

        // Create withdrawals table
        await pool.query(`CREATE TABLE IF NOT EXISTS withdrawals (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            amount NUMERIC NOT NULL,
            expected_earning NUMERIC NOT NULL,
            receiving_number VARCHAR(20) NOT NULL,
            status VARCHAR(20) DEFAULT 'pending',
            submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            processed_at TIMESTAMP,
            message TEXT DEFAULT 'Processing, expect funds within 48 hours',
            FOREIGN KEY (user_id) REFERENCES users(id)
        )`);
        console.log('âœ… Withdrawals table ready');

        // Create loan_applications table
        await pool.query(`CREATE TABLE IF NOT EXISTS loan_applications (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            phone VARCHAR(20) NOT NULL,
            id_front TEXT NOT NULL,
            id_back TEXT NOT NULL,
            status VARCHAR(20) DEFAULT 'pending',
            message TEXT DEFAULT 'System processing, wait for 48 to 72hrs for feedback',
            submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )`);
        console.log('âœ… Loan applications table ready');

        // Create savings table
        await pool.query(`CREATE TABLE IF NOT EXISTS savings (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            amount NUMERIC NOT NULL,
            tier VARCHAR(20) NOT NULL,
            interest_rate NUMERIC NOT NULL,
            daily_interest NUMERIC DEFAULT 0,
            total_balance NUMERIC NOT NULL,
            last_interest_update TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )`);
        console.log('âœ… Savings table ready');

        // Create savings_deposits table for direct deposits
        await pool.query(`CREATE TABLE IF NOT EXISTS savings_deposits (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            amount NUMERIC NOT NULL,
            tier VARCHAR(20) NOT NULL,
            mpesa_code VARCHAR(50) NOT NULL,
            recipient_name VARCHAR(255) NOT NULL,
            transaction_time TIMESTAMP NOT NULL,
            deposit_number VARCHAR(20) NOT NULL,
            status VARCHAR(20) DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )`);
        console.log('âœ… Savings deposits table ready');

        // Create savings_withdrawals table
        await pool.query(`CREATE TABLE IF NOT EXISTS savings_withdrawals (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            amount NUMERIC NOT NULL,
            status VARCHAR(20) DEFAULT 'pending',
            message TEXT DEFAULT 'Withdrawn amount to be accredited to login phone number. System processing withdrawal, expect funds within 48hrs',
            submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )`);
        console.log('âœ… Savings withdrawals table ready');

        // Create referrals table
        await pool.query(`CREATE TABLE IF NOT EXISTS referrals (
            id SERIAL PRIMARY KEY,
            referrer_id INTEGER NOT NULL,
            referred_id INTEGER NOT NULL,
            referral_code VARCHAR(50) NOT NULL,
            reward_amount NUMERIC DEFAULT 0,
            reward_paid BOOLEAN DEFAULT false,
            task_ai_purchased VARCHAR(50),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (referrer_id) REFERENCES users(id),
            FOREIGN KEY (referred_id) REFERENCES users(id)
        )`);
        await repairMysqlIntegerId('referrals');
        console.log('âœ… Referrals table ready');

        // Create timer_status table
        await pool.query(`CREATE TABLE IF NOT EXISTS timer_status (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            task_ai VARCHAR(50) NOT NULL,
            timer_type VARCHAR(20) NOT NULL,
            start_time TIMESTAMP NOT NULL,
            end_time TIMESTAMP NOT NULL,
            paused BOOLEAN DEFAULT false,
            completed BOOLEAN DEFAULT false,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )`);
        console.log('âœ… Timer status table ready');

        // Create recipient_names table (for M-PESA recipient validation)
        await pool.query(`CREATE TABLE IF NOT EXISTS recipient_names (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) UNIQUE NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        await repairMysqlIntegerId('recipient_names');
        console.log('âœ… Recipient names table ready');

        // Seed required recipient names every time so older databases with malformed
        // recipient rows can still accept valid AI-purchase messages.
        const defaultNames = [
            'SAFARICOM DATA BUNDLES',
            'SAFARICOM DATA BUNDLES FOR ACCOUNT SAFARICOM DATA BUNDLES'
        ];
        try {
            const idCol = pool.databaseClient === 'mysql'
                ? await pool.query(`SELECT COLUMN_TYPE, COLUMN_DEFAULT, EXTRA, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'recipient_names' AND COLUMN_NAME = 'id'`)
                : { rows: [{ COLUMN_TYPE: 'n/a', EXTRA: pool.databaseClient }] };
            const nameCount = await pool.query('SELECT COUNT(*) as count FROM recipient_names');
            agentDebugLog('server.js:recipient_names:schema', 'recipient_names id schema before seed', { client: pool.databaseClient, idCol: idCol.rows[0] || null, nameCount: nameCount.rows[0] && nameCount.rows[0].count }, 'A', 'post-fix');
        } catch (schemaErr) {
            agentDebugLog('server.js:recipient_names:schema', 'failed reading recipient_names schema', { err: String(schemaErr.message || schemaErr) }, 'A', 'post-fix');
        }
        for (const name of defaultNames) {
            try {
                await pool.query('INSERT INTO recipient_names (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
            } catch (seedErr) {
                agentDebugLog('server.js:recipient_names:seed', 'recipient_names seed insert failed', { err: String(seedErr.message || seedErr), code: seedErr.code || null, sql: seedErr.sql || null, nameLen: name.length }, 'A', 'post-fix');
                throw seedErr;
            }
        }

        // Create deposit_numbers table (for rotating deposit numbers)
        await pool.query(`CREATE TABLE IF NOT EXISTS deposit_numbers (
            id SERIAL PRIMARY KEY,
            phone_number VARCHAR(20) UNIQUE NOT NULL,
            active BOOLEAN DEFAULT true,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        await repairMysqlIntegerId('deposit_numbers');
        console.log('âœ… Deposit numbers table ready');

        // Insert default deposit number if none exists
        const countResult = await pool.query('SELECT COUNT(*) as count FROM deposit_numbers');
        if (countResult.rows[0].count == 0) {
            await pool.query('INSERT INTO deposit_numbers (phone_number) VALUES ($1)', ['0716235987']);
            console.log('âœ… Default deposit number inserted');
        }

        // Create mpesa_codes table (for universal M-PESA code validation)
        await pool.query(`CREATE TABLE IF NOT EXISTS mpesa_codes (
            id SERIAL PRIMARY KEY,
            mpesa_code VARCHAR(50) UNIQUE NOT NULL,
            transaction_type VARCHAR(20) NOT NULL,
            user_id INTEGER,
            amount NUMERIC NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        await repairMysqlIntegerId('mpesa_codes');
        console.log('âœ… M-PESA codes table ready');

        await pool.query('CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_user_id ON mpesa_transactions(user_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_mpesa_code ON mpesa_transactions(mpesa_code)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_withdrawals_user_id ON withdrawals(user_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_loan_applications_user_id ON loan_applications(user_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_savings_user_id ON savings(user_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_savings_withdrawals_user_id ON savings_withdrawals(user_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone)');
        if (pool.databaseClient !== 'sqlite' && process.env.USE_SQLITE !== 'true') {
            // MySQL permits multiple NULLs in a unique index, so this is the
            // equivalent of PostgreSQL's nullable partial index.
            await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_users_referral_code ON users(referralCode) WHERE referralCode IS NOT NULL');
            // One person can be referred once. Keep the earliest legacy record
            // if an older build wrote redundant relationship rows.
            if (pool.databaseClient === 'mysql') {
                await pool.query(`DELETE older FROM referrals older
                                  INNER JOIN referrals newer
                                  ON older.referred_id = newer.referred_id AND older.id > newer.id`);
            } else {
                await pool.query(`DELETE FROM referrals older USING referrals newer
                                  WHERE older.referred_id = newer.referred_id AND older.id > newer.id`);
            }
            await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_referrals_referred_id ON referrals(referred_id)');
            await pool.query('CREATE INDEX IF NOT EXISTS idx_referrals_referrer_created ON referrals(referrer_id, created_at DESC)');
            await pool.query('CREATE INDEX IF NOT EXISTS idx_mpesa_user_created ON mpesa_transactions(user_id, created_at DESC)');
            await pool.query('CREATE INDEX IF NOT EXISTS idx_mpesa_user_task_status ON mpesa_transactions(user_id, task_ai_number, status)');
            await pool.query('CREATE INDEX IF NOT EXISTS idx_withdrawals_user_submitted ON withdrawals(user_id, submitted_at DESC)');
            await pool.query('CREATE INDEX IF NOT EXISTS idx_loans_user_submitted ON loan_applications(user_id, submitted_at DESC)');
        }
        
        // Video task tables
        await pool.query(`CREATE TABLE IF NOT EXISTS videos (
            id SERIAL PRIMARY KEY,
            video_id VARCHAR(50) UNIQUE NOT NULL,
            title VARCHAR(255) NOT NULL,
            filename VARCHAR(255) NOT NULL,
            duration INTEGER NOT NULL,
            resolution VARCHAR(50),
            fps INTEGER,
            file_size INTEGER,
            mime_type VARCHAR(50) DEFAULT 'video/mp4',
            uploaded_by INTEGER,
            uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            action_sequences TEXT,
            difficulty VARCHAR(20) DEFAULT 'medium',
            status VARCHAR(20) DEFAULT 'active',
            task_ai_number VARCHAR(10),
            focus VARCHAR(80),
            prompt TEXT
        )`);
        console.log('✓ Videos table ready');

        await pool.query(`CREATE TABLE IF NOT EXISTS video_responses (
            id SERIAL PRIMARY KEY,
            challenge_id VARCHAR(50) UNIQUE NOT NULL,
            user_id INTEGER NOT NULL REFERENCES users(id),
            video_id INTEGER NOT NULL REFERENCES videos(id),
            user_annotations TEXT NOT NULL,
            expected_actions TEXT NOT NULL,
            accuracy_score NUMERIC,
            completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        console.log('✓ Video responses table ready');

        await pool.query(`CREATE TABLE IF NOT EXISTS video_metadata (
            id SERIAL PRIMARY KEY,
            video_id INTEGER NOT NULL REFERENCES videos(id),
            codec VARCHAR(50),
            bitrate INTEGER,
            color_space VARCHAR(50),
            duration_ms INTEGER
        )`);
        console.log('✓ Video metadata table ready');

        await pool.query(`CREATE TABLE IF NOT EXISTS ai_training_metrics (
            task_ai_number VARCHAR(10) PRIMARY KEY,
            contributions INTEGER NOT NULL DEFAULT 0,
            clips_annotated INTEGER NOT NULL DEFAULT 0,
            consensus_events INTEGER NOT NULL DEFAULT 0,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        for (const taskNumber of ['1', '2', '3', '4', '5', '6']) {
            await pool.query('INSERT INTO ai_training_metrics (task_ai_number) VALUES ($1) ON CONFLICT (task_ai_number) DO NOTHING', [taskNumber]);
        }
        console.log('✓ AI training metrics table ready');

        await pool.query(`CREATE TABLE IF NOT EXISTS task_choice_responses (
            id SERIAL PRIMARY KEY,
            challenge_hash VARCHAR(64) UNIQUE NOT NULL,
            user_id INTEGER NOT NULL,
            task_ai_number VARCHAR(10) NOT NULL,
            question_key VARCHAR(64) NOT NULL,
            question TEXT NOT NULL,
            response_value TEXT NOT NULL,
            options TEXT NOT NULL DEFAULT '[]',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )`);
        if (process.env.USE_SQLITE !== 'true') {
            await pool.query('CREATE INDEX IF NOT EXISTS idx_task_response_question ON task_choice_responses(question_key)');
        }
        console.log('✓ Task response statistics table ready');

        // Support databases created by earlier releases, whose request tables were missing
        // columns now used by the purchase, withdrawal, and collector flows.
        const legacyColumns = [
            ['videos', 'task_ai_number', 'VARCHAR(10)'],
            ['videos', 'focus', 'VARCHAR(80)'],
            ['videos', 'prompt', 'TEXT'],
            ['mpesa_transactions', 'recipient_name', 'VARCHAR(255)'],
            ['mpesa_transactions', 'transaction_time', 'TIMESTAMP'],
            ['mpesa_transactions', 'deposit_number', 'VARCHAR(20)'],
            ['mpesa_transactions', 'start_8hr', 'TIMESTAMP'],
            ['mpesa_transactions', 'timer_8hr_paused', 'BOOLEAN DEFAULT false'],
            ['mpesa_transactions', 'work_completed', 'BOOLEAN DEFAULT false'],
            ['mpesa_transactions', 'unlock_completed', 'BOOLEAN DEFAULT false'],
            ['mpesa_transactions', 'verified_by_sms_forwarder', 'BOOLEAN DEFAULT false'],
            ['mpesa_transactions', 'sms_forwarder_message_id', 'INTEGER'],
            ['mpesa_transactions', 'submitted_message', 'TEXT'],
            ['withdrawals', 'expected_earning', 'NUMERIC DEFAULT 0'],
            ['withdrawals', 'message', "TEXT DEFAULT 'Processing, expect funds within 48 hours'"],
            ['loan_applications', 'status', "VARCHAR(20) DEFAULT 'pending'"],
            ['loan_applications', 'message', "TEXT DEFAULT 'System processing, wait for 48 to 72hrs for feedback'"],
            ['users', 'first_name', 'VARCHAR(100)'],
            ['users', 'last_name', 'VARCHAR(100)'],
            ['users', 'email', 'VARCHAR(255)'],
            ['users', 'address_line_1', 'VARCHAR(255)'],
            ['users', 'address_line_2', 'VARCHAR(255)'],
            ['users', 'city', 'VARCHAR(120)'],
            ['users', 'region', 'VARCHAR(120)'],
            ['users', 'country', 'VARCHAR(120)'],
            ['users', 'postal_code', 'VARCHAR(40)'],
            ['users', 'birth_date', 'VARCHAR(20)'],
            ['users', 'work_eligibility', 'VARCHAR(20)'],
            ['users', 'expertise', "TEXT DEFAULT '[]'"],
            ['users', 'primary_role', 'VARCHAR(160)'],
            ['users', 'experience_level', 'VARCHAR(80)'],
            ['users', 'availability', 'VARCHAR(40)'],
            ['users', 'languages', 'TEXT'],
            ['users', 'opportunity_updates', 'BOOLEAN DEFAULT false'],
            ['users', 'terms_accepted_at', 'TIMESTAMP'],
            ['users', 'onboarding_complete', 'BOOLEAN DEFAULT false'],
            ['users', 'withdrawalHistory', "TEXT DEFAULT '[]'"],
            ['users', 'vps_notice_required', 'BOOLEAN DEFAULT false'],
            ['users', 'vps_notice_acknowledged_at', 'TIMESTAMP']
        ];
        for (const [table, column, definition] of legacyColumns) await ensureColumn(table, column, definition);

        for (const tableName of [
            'users', 'mpesa_transactions', 'inbound_sms_messages', 'withdrawals',
            'loan_applications', 'savings', 'savings_deposits', 'savings_withdrawals',
            'timer_status', 'videos', 'video_responses', 'video_metadata',
            'task_choice_responses'
        ]) {
            await repairMysqlIntegerId(tableName);
        }

        await registerAllVideos(pool);
        resolveVideoTasksReady();
        console.log('Action-sequence clips registered');
        console.log('Database indexes ready');
        agentDebugLog('server.js:initializeTables:success', 'initializeTables completed', { client: pool.databaseClient }, 'A', 'post-fix');

    } catch (err) {
        console.error('âŒ Error creating tables:', err.message, err.sql || '');
        agentDebugLog('server.js:initializeTables:catch', 'initializeTables failed', { err: String(err.message || err), code: err.code || null, sql: err.sql || null }, 'A', 'post-fix');
        throw err;
    }
}

// Initialize database connection
// testDatabaseConnection() called at bottom of file

// ===== HELPER FUNCTIONS =====
async function repairMysqlIntegerId(tableName) {
    if (pool.databaseClient !== 'mysql') return { skipped: true };
    const allowedTables = {
        users: true,
        mpesa_transactions: true,
        inbound_sms_messages: true,
        withdrawals: true,
        loan_applications: true,
        savings: true,
        savings_deposits: true,
        savings_withdrawals: true,
        referrals: true,
        timer_status: true,
        recipient_names: true,
        deposit_numbers: true,
        mpesa_codes: true,
        videos: true,
        video_responses: true,
        video_metadata: true,
        task_choice_responses: true
    };
    if (!allowedTables[tableName]) {
        throw new Error(`Refusing MySQL id repair for unknown table ${tableName}`);
    }

    try {
    const exists = await pool.query(
        `SELECT 1 FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = $1 LIMIT 1`,
        [tableName]
    );
    if (!exists.rows.length) return { missing: true };

    const idCol = await pool.query(
        `SELECT EXTRA FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = $1 AND COLUMN_NAME = 'id' LIMIT 1`,
        [tableName]
    );
    if (!idCol.rows.length) return { noId: true };

    const extra = String(idCol.rows[0].EXTRA || idCol.rows[0].extra || '');
    const primaryKey = await pool.query(
        `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = $1
            AND CONSTRAINT_TYPE = 'PRIMARY KEY'
          LIMIT 1`,
        [tableName]
    );
    if (!primaryKey.rows.length) {
        await pool.query(`ALTER TABLE ${tableName} ADD PRIMARY KEY (id)`);
    }
    if (!/\bauto_increment\b/i.test(extra)) {
        await pool.query(`ALTER TABLE ${tableName} MODIFY COLUMN id INT NOT NULL AUTO_INCREMENT`);
        agentDebugLog('server.js:repairMysqlIntegerId', 'repaired MySQL id AUTO_INCREMENT', { tableName, previousExtra: extra }, 'A', 'post-fix');
        return { repaired: true, tableName, previousExtra: extra };
    }
    return { repaired: false, tableName, extra };
    } catch (error) {
        error.message = `MySQL id repair failed for ${tableName}: ${error.message}`;
        agentDebugLog('server.js:repairMysqlIntegerId', 'MySQL id repair failed', { tableName, err: String(error.message), code: error.code || null, sql: error.sql || null }, 'A', 'post-fix');
        throw error;
    }
}

async function repairDepositNumbersMysqlSchema() {
    try {
        await repairMysqlIntegerId('deposit_numbers');
    } catch (error) {
        console.warn('Deposit numbers MySQL schema repair warning:', error.message);
    }
}

function calculateExpectedEarning(totalEarned) {
    return totalEarned * 0.80;
}

const FIRST_WITHDRAWAL_RATE = 0.30;

async function getLatestVerifiedRegistrationFee(userId, query = pool.query.bind(pool)) {
    const result = await query(
        `SELECT amount
         FROM mpesa_transactions
         WHERE user_id = $1 AND status = 'completed'
         ORDER BY created_at DESC LIMIT 1`,
        [userId]
    );
    return Number(result.rows[0]?.amount || 0);
}

function generateReferralCode(phone) {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const randomLetter = letters[Math.floor(Math.random() * letters.length)];
    return `${phone}-${randomLetter}`;
}

function formatPhoneNumber(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.startsWith('254') && digits.length === 12) return digits;
    if (digits.startsWith('0') && digits.length === 10) return '254' + digits.slice(1);
    if (digits.length === 9) return '254' + digits;
    if (digits.length === 12 && digits.startsWith('254')) return digits;
    return '';
}

// Registration accepts either the short referral identifier or the complete
// share link produced by the referral page. Store and validate the canonical
// identifier so a pasted URL cannot fail an otherwise valid application.
function normalizeReferralIdentifier(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        const parsed = new URL(raw);
        const fromQuery = parsed.searchParams.get('ref') || parsed.searchParams.get('referral');
        if (fromQuery) return fromQuery.trim();
    } catch (_) {
        // A plain code or phone number is expected; fall through unchanged.
    }
    const queryMatch = raw.match(/[?&](?:ref|referral)=([^&#\s]+)/i);
    if (queryMatch) {
        try { return decodeURIComponent(queryMatch[1]).trim(); } catch (_) { return queryMatch[1].trim(); }
    }
    return raw;
}

function isSupportedPhoneNumber(phone) {
    const normalized = formatPhoneNumber(phone);
    return /^254[17]\d{8}$/.test(normalized);
}

function last9KenyanMobile(value) {
    let digits = String(value || '').replace(/\D/g, '');
    if (digits.startsWith('254')) digits = digits.slice(3);
    else if (digits.startsWith('0')) digits = digits.slice(1);
    if (digits.length > 9) digits = digits.slice(-9);
    return digits.length === 9 ? digits : '';
}

function phonesFromMpesaRecipient(value) {
    const text = String(value || '');
    const found = new Set();
    const matches = text.match(/(?:\+?254|0)?[17]\d{8}/g) || [];
    for (const match of matches) {
        const key = last9KenyanMobile(match);
        if (key) found.add(key);
    }
    return [...found];
}

function recipientNameWithoutPhone(value) {
    return String(value || '')
        .replace(/(?:\+?254|0)?[17]\d{8}/g, ' ')
        .replace(/[^A-Z0-9\s]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();
}

async function findAllowedMpesaRecipient(queryFn, recipientName) {
    const original = String(recipientName || '').trim();
    const cleaned = recipientNameWithoutPhone(original);
    const validName = await queryFn(
        `SELECT id FROM recipient_names
         WHERE (
                LOWER($1) LIKE CONCAT('%', LOWER(name), '%')
             OR LOWER(name) LIKE CONCAT('%', LOWER($1), '%')
         )
            OR (
                $2 <> '' AND (
                    LOWER($2) LIKE CONCAT('%', LOWER(name), '%')
                 OR LOWER(name) LIKE CONCAT('%', LOWER($2), '%')
                )
         )
         LIMIT 1`,
        [original, cleaned]
    );
    if (validName.rows.length) return { ok: true, via: 'name' };

    const extractedPhones = phonesFromMpesaRecipient(original);
    if (!extractedPhones.length) return { ok: false, via: 'none', phoneCount: 0 };

    const deposits = await queryFn('SELECT phone_number FROM deposit_numbers WHERE active = true');
    const allowedPhones = new Set();
    for (const row of deposits.rows) {
        const key = last9KenyanMobile(row.phone_number || row.phone_Number);
        if (key) allowedPhones.add(key);
    }
    if (extractedPhones.some((phone) => allowedPhones.has(phone))) {
        return { ok: true, via: 'deposit', phoneCount: extractedPhones.length, depositCount: allowedPhones.size };
    }
    return { ok: false, via: 'none', phoneCount: extractedPhones.length, depositCount: allowedPhones.size };
}

function isAdult(birthDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(birthDate || ''))) return false;
    const birth = new Date(`${birthDate}T00:00:00Z`);
    if (Number.isNaN(birth.getTime())) return false;
    const now = new Date();
    let age = now.getUTCFullYear() - birth.getUTCFullYear();
    const beforeBirthday = now.getUTCMonth() < birth.getUTCMonth() || (now.getUTCMonth() === birth.getUTCMonth() && now.getUTCDate() < birth.getUTCDate());
    if (beforeBirthday) age -= 1;
    return age >= 18 && age < 120;
}

function validateWithdrawalTime() {
    // The policy is in East Africa Time. A deployed host may run in UTC or
    // another region, so the process timezone must not determine eligibility.
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Africa/Nairobi',
        weekday: 'short',
        hour: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    const hour = Number(values.hour);
    const isWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(values.weekday);

    return isWeekday && hour >= 10 && hour < 15;
}

function parseMpesaMessage(message) {
    console.log("Parsing M-PESA message:", message);
    if (typeof message !== 'string' || message.length > 1500) {
        return { success: false, error: 'Invalid M-PESA message format' };
    }

    const patterns = [
        {
            // NEW FORMAT: UIBAX6D87K Confirmed.You have received Ksh1,000.00 from Morgan Barasa 0717***357 on 11/9/26 at 6:25 PM New M-PESA balance is Ksh372.99. Invest & earn daily interest
            regex: /^([A-Z0-9]{8,12})\s+Confirmed\.You have received Ksh\s*([\d,]+\.?\d*)\s+from\s+(.+?)\s+on\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+at\s+(\d{1,2}:\d{2}\s*[AP]M)/i,
            map: { mpesaCode: 1, amount: 2, recipient: 3, date: 4, time: 5 }
        },
        {
            // Standard M-PESA: Confirmed. Ksh1,000.00 received from NAME 07... ON date AT time
            regex: /(?:(?:Confirmed\.|Received\.)\s*)?Ksh(?:\s*)?([\d,]+\.?\d*)(?:\s*)?(?:received|sent) from (?:(?:\d+\s*)?([A-Z\s]+[A-Z]))(?:\s*)?(\d+)(?:\s*)?on (\d+\/\d+\/\d+)(?:\s*)?at (\d+:\d+\s*[AP]M)/i,
            map: { amount: 1, recipient: 2, mpesaCode: 3, date: 4, time: 5 }
        },
        {
            // Received M-PESA: You have received Ksh1,000.00 from NAME 07... on date at time
            regex: /(?:(?:Confirmed\.|Received\.)\s*)?You have received Ksh(?:\s*)?([\d,]+\.?\d*)(?:\s*)?from (?:(?:\d+\s*)?([A-Z\s]+[A-Z]))(?:\s*)?(\d+)(?:\s*)?on (\d+\/\d+\/\d+)(?:\s*)?at (\d+:\d+\s*[AP]M)/i,
            map: { amount: 1, recipient: 2, mpesaCode: 3, date: 4, time: 5 }
        },
        {
            // Sent to you by: 1,000.00 sent to you by NAME 07... on date at time
            regex: /([\d,]+\.?\d*)(?:\s*)?sent to you by (?:(?:\d+\s*)?([A-Z\s]+[A-Z]))(?:\s*)?(\d+)(?:\s*)?on (\d+\/\d+\/\d+)(?:\s*)?(\d+:\d+\s*[AP]M)/i,
            map: { amount: 1, recipient: 2, mpesaCode: 3, date: 4, time: 5 }
        },
        {
            // Standard Outgoing: CODE Confirmed. Ksh20.00 sent to NAME for account... on date at time
            regex: /([A-Z0-9]{8,12})\s+Confirmed\.\s+Ksh\s*([\d,]+\.?\d*)\s+sent to\s+(.+?)(?:\s+for\s+|\s+on\s+)(\d{1,2}\/\d{1,2}\/\d{2,4})\s+at\s+(\d{1,2}:\d{2}\s*[AP]M)/i,
            map: { mpesaCode: 1, amount: 2, recipient: 3, date: 4, time: 5 }
        },
        {
            // Label format: Amount: 1,000.00 From: NAME 07... Date: ... Time: ...
            regex: /Amount: ([\d,]+\.?\d*).*?From: (?:(?:\d+\s*)?([A-Z\s]+[A-Z]))(?:\s*)?(\d+).*?Date: (\d+\/\d+\/\d+).*?Time: (\d+:\d+\s*[AP]M)/i,
            map: { amount: 1, recipient: 2, mpesaCode: 3, date: 4, time: 5 }
        }
    ];

    for (const item of patterns) {
        const match = message.match(item.regex);
        if (match) {
            try {
                const amount = parseFloat(match[item.map.amount].replace(/,/g, ''));
                let recipientName = match[item.map.recipient].trim().toUpperCase();

                // Secondary check: if recipient contains 'FOR ACCOUNT', strip it
                if (recipientName.includes(" FOR ACCOUNT")) {
                    recipientName = recipientName.split(" FOR ACCOUNT")[0].trim();
                }

                const mpesaCode = match[item.map.mpesaCode];
                const dateStr = match[item.map.date];
                const timeStr = match[item.map.time];

                // Explicitly parse DD/MM/YY(YY)
                const dateParts = dateStr.split('/');
                const day = parseInt(dateParts[0]);
                const month = parseInt(dateParts[1]) - 1; // JS months are 0-indexed
                let year = parseInt(dateParts[2]);
                if (year < 100) year += 2000;

                // Parse time
                const timeMatch = timeStr.match(/(\d+):(\d+)\s*([AP]M)/i);
                let hours = parseInt(timeMatch[1]);
                const minutes = parseInt(timeMatch[2]);
                const ampm = timeMatch[3].toUpperCase();
                if (ampm === 'PM' && hours < 12) hours += 12;
                if (ampm === 'AM' && hours === 12) hours = 0;

                // Message time is in EAT (UTC+3). Convert to absolute UTC for consistent comparison.
                const transactionTime = new Date(Date.UTC(year, month, day, hours - 3, minutes));

                console.log("âœ… Parsed successfully:", { amount, recipientName, mpesaCode, transactionTime });
                agentDebugLog('server.js:parseMpesaMessage', 'parser matched a pattern', { patternIndex: patterns.indexOf(item), recipientLen: recipientName.length, recipientHasDigit: /\d/.test(recipientName), recipientHasSafaricom: /SAFARICOM/i.test(recipientName), amount, codeLen: String(mpesaCode || '').length }, 'B', 'post-fix');

                return {
                    success: true,
                    amount: amount,
                    recipientName: recipientName,
                    mpesaCode: mpesaCode,
                    transactionTime: transactionTime
                };
            } catch (e) {
                console.error("âŒ Error during parsing logic:", e);
            }
        }
    }

    console.warn("âš ï¸ No pattern matched the message");
    return {
        success: false,
        error: 'Invalid M-PESA message format'
    };
}

// Award the one permitted referral reward after a payment becomes verified.
// Both the existing collector path and the SMS Forwarder path call this helper.
async function creditReferralForFirstTaskPurchase(userId, taskAiNumber, aiTask) {
    return models.referrals.awardFirstVerifiedPurchase(userId, taskAiNumber, aiTask);
}

// ===== SITE ENTRYPOINT =====
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/landing.html'));
});

// ===== REGISTER ENDPOINT =====
app.post('/api/register', rateLimitAuth, async (req, res) => {
    console.log('Registration request received');

    const {
        phone, password, referredBy, firstName, lastName, email,
        addressLine1, addressLine2, city, region, country, postalCode,
        birthDate, workEligibility, expertise, primaryRole, experienceLevel,
        availability, languages, opportunityUpdates, termsAccepted, profileAccurate
    } = req.body;

    if (!phone || !password || !firstName || !lastName || !email || !addressLine1 || !addressLine2 || !city || !region || !country || !postalCode || !birthDate || !workEligibility || !primaryRole || !experienceLevel || !availability || !languages) {
        return res.status(400).json({
            success: false,
            message: 'Complete all required registration fields.'
        });
    }

    const formattedPhone = formatPhoneNumber(phone);
    const normalizedEmail = String(email).trim().toLowerCase();
    const safeExpertise = Array.isArray(expertise) ? expertise.filter(item => typeof item === 'string').slice(0, 12) : [];

    if (!isSupportedPhoneNumber(formattedPhone)) return res.status(400).json({ success: false, message: 'Use a valid supported phone number.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return res.status(400).json({ success: false, message: 'Use a valid email address.' });
    if (String(password).length < 8) return res.status(400).json({ success: false, message: 'Use a password with at least 8 characters.' });
    if (!isAdult(birthDate)) return res.status(400).json({ success: false, message: 'You must be at least 18 years old to register.' });
    if (workEligibility !== 'yes' || !termsAccepted || !profileAccurate) return res.status(400).json({ success: false, message: 'Eligibility, accurate profile confirmation, and acceptance of the Terms are required.' });
    if (!safeExpertise.length) return res.status(400).json({ success: false, message: 'Choose at least one area of expertise.' });
    const referralIdentifier = normalizeReferralIdentifier(referredBy);
    if (!referralIdentifier) return res.status(400).json({ success: false, message: 'Paste a valid referral link or referral code to register.' });
    const referralCode = generateReferralCode(formattedPhone);

    try {
        const existingUser = await pool.query('SELECT id FROM users WHERE phone = $1', [formattedPhone]);

        if (existingUser.rows.length > 0) {
            return res.status(409).json({
                success: false,
                message: 'Phone number already registered'
            });
        }

        const referrerRes = await pool.query(
            'SELECT id FROM users WHERE phone = $1 OR referralCode = $1',
            [referralIdentifier]
        );
        if (referrerRes.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'This referral code is not valid. Ask your referrer to share their current code.' });
        }
        const verifiedReferrerId = referrerRes.rows[0].id;

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Task access is granted by an independently verified payment; no
        // artificial purchase-unlock delay is stored for a new account.
        const aiTimers = {};

        const workTimers = {
            AI_1: { startTime: null, duration: 28800000, paused: false, pausedAt: null, completed: false },
            AI_2: { startTime: null, duration: 28800000, paused: false, pausedAt: null, completed: false },
            AI_3: { startTime: null, duration: 28800000, paused: false, pausedAt: null, completed: false },
            AI_4: { startTime: null, duration: 28800000, paused: false, pausedAt: null, completed: false },
            AI_5: { startTime: null, duration: 28800000, paused: false, pausedAt: null, completed: false },
            AI_6: { startTime: null, duration: 28800000, paused: false, pausedAt: null, completed: false }
        };

        const userId = await withTransaction(async (client) => {
            // Revalidate the inviter while the registration writes are open.
            const currentReferrer = await client.query(
                'SELECT id FROM users WHERE id = $1 AND (phone = $2 OR referralCode = $2) FOR KEY SHARE',
                [verifiedReferrerId, referralIdentifier]
            );
            if (!currentReferrer.rows.length) {
                const error = new Error('This referral code is no longer valid.');
                error.code = 'REFERRER_MISSING';
                throw error;
            }

            const result = await client.query(
                `INSERT INTO users (
                    phone, password, referralCode, referredBy, aiTimers, workTimers, lastLogin, lastActivity,
                    first_name, last_name, email, address_line_1, address_line_2, city, region, country, postal_code,
                    birth_date, work_eligibility, expertise, primary_role, experience_level, availability, languages,
                    opportunity_updates, terms_accepted_at, onboarding_complete, vps_notice_required
                 ) VALUES (
                    $1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
                    $7, $8, $9, $10, $11, $12, $13, $14, $15,
                    $16, $17, $18, $19, $20, $21, $22, $23, CURRENT_TIMESTAMP, true, true
                 ) RETURNING id`,
                [
                    formattedPhone, hashedPassword, referralCode, referralIdentifier, JSON.stringify(aiTimers), JSON.stringify(workTimers),
                    String(firstName).trim(), String(lastName).trim(), normalizedEmail, String(addressLine1).trim(), String(addressLine2 || '').trim(),
                    String(city).trim(), String(region).trim(), String(country).trim(), String(postalCode).trim(),
                    birthDate, workEligibility, JSON.stringify(safeExpertise), String(primaryRole).trim(), String(experienceLevel).trim(),
                    String(availability).trim(), String(languages).trim(), Boolean(opportunityUpdates)
                ]
            );
            const newUserId = result.rows[0].id;
            await models.referrals.createForRegistration(client, {
                referrerId: verifiedReferrerId,
                referredId: newUserId,
                referralCode: referralIdentifier
            });
            return newUserId;
        });

        const token = createToken(userId);
        setAuthCookie(res, token);

        res.status(201).json({
            success: true,
            message: 'Account created successfully',
            token: token,
            userId: userId,
            phone: formattedPhone,
            referralCode: referralCode,
            totalEarned: 0,
            expectedEarning: 0,
            savingsBalance: 0,
            aiTimers: aiTimers,
            workTimers: workTimers,
            mpesaSubmissions: [],
            vpsRoutingNoticeRequired: true
        });

    } catch (error) {
        console.error('âŒ Registration error:', error);
        if (error.code === '23505') {
            return res.status(409).json({ success: false, message: 'This phone number is already registered. Please log in instead.' });
        }
        if (error.code === 'REFERRER_MISSING') {
            return res.status(400).json({ success: false, message: error.message });
        }
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// ===== LOGIN ENDPOINT =====
app.post('/api/login', rateLimitAuth, async (req, res) => {
    const { phone, password } = req.body;

    if (!phone || !password) {
        return res.status(400).json({
            success: false,
            message: 'Phone and password required'
        });
    }

    const formattedPhone = formatPhoneNumber(phone);

    try {
        const result = await pool.query('SELECT * FROM users WHERE phone = $1', [formattedPhone]);
        const user = result.rows[0];

        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Invalid phone or password'
            });
        }

        const isPasswordValid = await bcrypt.compare(password, user.password);

        if (!isPasswordValid) {
            return res.status(401).json({
                success: false,
                message: 'Invalid phone or password'
            });
        }

        await pool.query('UPDATE users SET lastLogin = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

        const expectedEarning = calculateExpectedEarning(user.totalearned || 0);

        const token = createToken(user.id);
        setAuthCookie(res, token);

        res.json({
            success: true,
            message: 'Login successful',
            token: token,
            userId: user.id,
            phone: user.phone,
            referralCode: user.referralcode,
            totalEarned: parseFloat(user.totalearned) || 0,
            expectedEarning: expectedEarning,
            savingsBalance: parseFloat(user.savingsbalance) || 0,
            aiTimers: user.aitimers ? JSON.parse(user.aitimers) : {},
            workTimers: user.worktimers ? JSON.parse(user.worktimers) : {},
            mpesaSubmissions: user.mpesasubmissions ? JSON.parse(user.mpesasubmissions) : [],
            vpsRoutingNoticeAcknowledged: Boolean(user.vps_notice_acknowledged_at),
            vpsRoutingNoticeRequired: Boolean(user.vps_notice_required) && !user.vps_notice_acknowledged_at
        });

    } catch (error) {
        console.error('âŒ Login error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// ===== UPDATE USER ACCOUNT DATA =====
app.use('/api/user', requireUserOrLocalControlTower);

// Use the signed session as the account identity. Client-side storage is only
// a convenience and may be stale after another person signs in on this device.
app.get('/api/user/me', requireAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, phone FROM users WHERE id = $1', [req.authUserId]);
        const user = result.rows[0];
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({ success: true, userId: user.id, phone: user.phone });
    } catch (error) {
        console.error('Current user lookup error:', error);
        res.status(500).json({ success: false, message: 'Unable to identify the current user' });
    }
});

// This acknowledgement is scoped to the signed-in user rather than a browser,
// so it remains acknowledged after a logout, refresh, or device change.
app.get('/api/user/vps-routing-notice', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT vps_notice_required, vps_notice_acknowledged_at FROM users WHERE id = $1',
            [req.authUserId]
        );
        const user = result.rows[0];
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({
            success: true,
            required: Boolean(user.vps_notice_required),
            acknowledged: Boolean(user.vps_notice_acknowledged_at)
        });
    } catch (error) {
        console.error('VPS routing notice status error:', error);
        res.status(500).json({ success: false, message: 'Unable to load VPS routing notice status' });
    }
});

app.post('/api/user/vps-routing-notice/acknowledge', async (req, res) => {
    try {
        await pool.query(
            'UPDATE users SET vps_notice_acknowledged_at = CURRENT_TIMESTAMP WHERE id = $1',
            [req.authUserId]
        );
        res.json({ success: true });
    } catch (error) {
        console.error('VPS routing notice acknowledgement error:', error);
        res.status(500).json({ success: false, message: 'Unable to save your acknowledgement. Please try again.' });
    }
});

app.post('/api/user/update', async (req, res) => {
    const { token, totalEarned, expectedEarning, aiTimers, workTimers, referralCode } = req.body;

    if (!token) {
        return res.status(400).json({ success: false, message: 'Token required' });
    }

    const userId = req.authUserId;

    try {
        if (referralCode) {
            await pool.query(
                'UPDATE users SET referralCode = $1, lastActivity = CURRENT_TIMESTAMP WHERE id = $2',
                [referralCode, userId]
            );
            return res.json({
                success: true,
                message: 'Referral code updated successfully'
            });
        }

        const rowLock = pool.databaseClient === 'sqlite' ? '' : ' FOR UPDATE';
        const outcome = await withTransaction(async (client) => {
            const query = client.query.bind(client);
            const user = await query(`SELECT id FROM users WHERE id = $1${rowLock}`, [userId]);
            if (!user.rows.length) {
                return { status: 404, body: { success: false, message: 'User not found' } };
            }

            const accountAccessState = await getAccountAccessState(userId, query);
            if (accountAccessState.restricted) {
                return {
                    status: 403,
                    body: {
                        success: false,
                        message: accountAccessState.message,
                        withdrawalRestriction: toPublicRestriction(accountAccessState)
                    }
                };
            }

            await query(
                `UPDATE users SET 
                 totalEarned = $1, 
                 expectedEarning = $2,
                 aiTimers = $3, 
                 workTimers = $4, 
                 lastActivity = CURRENT_TIMESTAMP 
                 WHERE id = $5`,
                [totalEarned || 0, expectedEarning || 0,
                JSON.stringify(aiTimers || {}),
                JSON.stringify(workTimers || {}),
                    userId]
            );
            return { status: 200, body: { success: true, message: 'Account updated successfully' } };
        });
        res.status(outcome.status).json(outcome.body);
    } catch (error) {
        console.error('âŒ Update error:', error);
        res.status(500).json({ success: false, message: 'Failed to update account' });
    }
});

// ===== GET USER ACCOUNT DATA =====
app.get('/api/user/:userId', async (req, res) => {
    const userId = req.params.userId;

    try {
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
        const user = result.rows[0];

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        const expectedEarning = calculateExpectedEarning(parseFloat(user.totalearned) || 0);
        const registrationFee = await getLatestVerifiedRegistrationFee(userId);
        const accountAccessState = await getAccountAccessState(userId, pool.query.bind(pool));
        const withdrawalCount = accountAccessState.withdrawalCount;
        const firstWithdrawalAmount = registrationFee * FIRST_WITHDRAWAL_RATE;

        res.json({
            success: true,
            userId: user.id,
            phone: user.phone,
            referralCode: user.referralcode,
            totalEarned: parseFloat(user.totalearned) || 0,
            expectedEarning: expectedEarning,
            registrationFee,
            // Keep this field for existing clients; for a first request it is
            // now the fixed permitted amount rather than a minimum.
            minimumWithdrawal: firstWithdrawalAmount,
            firstWithdrawalAmount,
            withdrawalCount,
            withdrawalRestriction: toPublicRestriction(accountAccessState),
            savingsBalance: parseFloat(user.savingsbalance) || 0,
            aiTimers: user.aitimers ? JSON.parse(user.aitimers) : {},
            workTimers: user.worktimers ? JSON.parse(user.worktimers) : {},
            mpesaSubmissions: user.mpesasubmissions ? JSON.parse(user.mpesasubmissions) : []
        });
    } catch (error) {
        console.error('âŒ Get user error:', error);
        res.status(404).json({
            success: false,
            message: 'User not found'
        });
    }
});

// ===== GET DEPOSIT NUMBERS =====
app.get('/api/deposit-numbers', async (req, res) => {
    try {
        const result = await pool.query('SELECT phone_number FROM deposit_numbers WHERE active = true ORDER BY id');
        const numbers = result.rows.map(row => row.phone_number);
        res.json({ numbers: numbers });
    } catch (error) {
        console.error('âŒ Deposit numbers error:', error);
        res.status(500).json({ numbers: [] });
    }
});

// ===== M-PESA PAYMENT SUBMISSION =====
app.post('/api/user/mpesa-payment', async (req, res) => {
    const { userId, phone, amount, mpesaMessage, parsedData, aiTask, taskAiNumber, depositNumber, serverTime } = req.body;

    if (!userId || !mpesaMessage || !aiTask || !taskAiNumber) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    let parsed = parsedData;
    if (!parsed || !parsed.success) {
        parsed = parseMpesaMessage(mpesaMessage);
    }

    if (!parsed.success) {
        return res.status(400).json({ success: false, message: 'Invalid M-PESA message format' });
    }

    const parsedAmount = parsed.amount;
    const recipientName = parsed.recipientName;
    const mpesaCode = parsed.mpesaCode;
    // Ensure transactionTime is a Date object (client may send ISO string via parsedData)
    let transactionTime = parsed.transactionTime;
    if (transactionTime instanceof Date) {
        // Already a Date object
    } else if (typeof transactionTime === 'string' || typeof transactionTime === 'number') {
        transactionTime = new Date(transactionTime);
    } else {
        transactionTime = new Date(); // fallback to now
    }
    // Validate the date is valid
    if (isNaN(transactionTime.getTime())) {
        transactionTime = new Date();
    }

    console.log(`ðŸ” Processing M-PESA payment: Code=${mpesaCode}, Amount=${parsedAmount}, Recipient=${recipientName}, Time=${transactionTime}`);
    agentDebugLog('server.js:mpesa-payment:parsed', 'parsed pasted M-PESA fields', { usedClientParsed: Boolean(parsedData && parsedData.success), recipientLen: String(recipientName || '').length, recipientHasDigit: /\d/.test(String(recipientName || '')), recipientHasSafaricom: /SAFARICOM/i.test(String(recipientName || '')), amount: parsedAmount, codeLen: String(mpesaCode || '').length, msgLen: String(mpesaMessage || '').length }, 'B', 'post-fix');

    if (Math.abs(parsedAmount - amount) > 1) {
        const errorMsg = `Amount mismatch: Message has Ksh. ${parsedAmount}, but package ${aiTask} requires Ksh. ${amount}`;
        console.warn(`âŒ ${errorMsg}`);
        return res.status(400).json({
            success: false,
            message: errorMsg
        });
    }

    try {
        // Production payments always require a matching SMS independently
        // received by the payment phone. There is no client-controlled or
        // time-based unlock path.
        const smsForwarderEnabled = process.env.SMS_FORWARDER_ENABLED === 'true';
        if (!smsForwarderEnabled) {
            return res.status(503).json({ success: false, message: 'Payment confirmation is temporarily unavailable. Please try again once the payment phone is online.' });
        }

        let matchingInboundMessage = await models.inboundSmsMessages.findUnmatchedByCode(mpesaCode, parsedAmount);
        if (matchingInboundMessage) {
            const verification = verifyMessagePair({
                pastedMessage: mpesaMessage,
                receivedMessage: matchingInboundMessage.sms_body,
                parseMpesaMessage,
                expectedAmount: amount
            });
            if (!verification.valid) {
                return res.status(400).json({ success: false, message: verification.reason });
            }
        }

        const transactionId = await withTransaction(async (client) => {
            const existingCode = await client.query('SELECT id FROM mpesa_codes WHERE mpesa_code = $1 FOR KEY SHARE', [mpesaCode]);
            if (existingCode.rows.length > 0) {
                const error = new Error('Invalid M-PESA message (duplicate transaction code)');
                error.code = 'DUPLICATE_MPESA_CODE';
                throw error;
            }
            // Only validate amount matches the AI task requirement
            // No recipient validation needed - compare only M-PESA code and amount with SMS forwarder
            await client.query('INSERT INTO mpesa_codes (mpesa_code, transaction_type, user_id, amount) VALUES ($1, $2, $3, $4)',
                [mpesaCode, 'investment', userId, amount]);
            // Convert transactionTime to MySQL-compatible format (YYYY-MM-DD HH:MM:SS)
            const mysqlDateTime = transactionTime.toISOString().slice(0, 19).replace('T', ' ');
            const transactionResult = await models.mpesaTransactions.createPurchase({
                userId, phone, amount, mpesaCode, recipientName, transactionTime: mysqlDateTime,
                aiTask, taskAiNumber, depositNumber,
                status: 'awaiting_sms',
                submittedMessage: mpesaMessage
            }, client);
            return transactionResult.rows[0].id;
        });

        // An SMS can reach the phone a few seconds before the contributor
        // finishes pasting its code. Reconcile that already-audited receipt
        // here rather than leaving a valid payment stuck as unmatched.
        let immediateAccess = false;
        // Query once more after inserting the transaction. This closes the
        // small race where the payment phone delivers the SMS while the user
        // is submitting the pasted message.
        if (!matchingInboundMessage) {
            matchingInboundMessage = await models.inboundSmsMessages.findUnmatchedByCode(mpesaCode, parsedAmount);
        }
        if (matchingInboundMessage) {
            const verification = verifyMessagePair({
                pastedMessage: mpesaMessage,
                receivedMessage: matchingInboundMessage.sms_body,
                parseMpesaMessage,
                expectedAmount: amount
            });
            if (!verification.valid) {
                return res.status(409).json({
                    success: false,
                    message: 'The matching M-PESA SMS could not be verified. Please contact support before resubmitting.'
                });
            }
            await models.mpesaTransactions.markVerified(transactionId, matchingInboundMessage.id);
            await models.inboundSmsMessages.markMatched(matchingInboundMessage.id, transactionId);
            await creditReferralForFirstTaskPurchase(userId, taskAiNumber, aiTask);
            immediateAccess = true;
        }

        res.json({
            success: true,
            message: immediateAccess ? 'Payment validated. Your Task AI workspace is ready.' : 'Payment submitted. Waiting for the matching M-PESA SMS from the payment phone.',
            transactionId: transactionId,
            immediateAccess,
            awaitingSmsConfirmation: !immediateAccess
        });

    } catch (error) {
        console.error('âŒ M-PESA payment error:', error);
        if (error.code === 'DUPLICATE_MPESA_CODE' || error.code === '23505') {
            return res.status(400).json({ success: false, message: 'Invalid M-PESA message (duplicate transaction code)' });
        }
        res.status(500).json({ success: false, message: 'Failed to record payment' });
    }
});

// ===== SAVINGS DIRECT DEPOSIT =====
app.post('/api/user/savings-direct-deposit', async (req, res) => {
    const { userId, amount, tier, mpesaMessage, parsedData, depositNumber } = req.body;

    if (!userId || !mpesaMessage || !tier) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    let parsed = parsedData;
    if (!parsed || !parsed.success) {
        parsed = parseMpesaMessage(mpesaMessage);
    }

    if (!parsed.success) {
        return res.status(400).json({ success: false, message: 'Invalid M-PESA message format' });
    }

    const parsedAmount = parsed.amount;
    const recipientName = parsed.recipientName;
    const mpesaCode = parsed.mpesaCode;
    // Ensure transactionTime is a Date object (client may send ISO string via parsedData)
    let transactionTime = parsed.transactionTime;
    if (transactionTime instanceof Date) {
        // Already a Date object
    } else if (typeof transactionTime === 'string' || typeof transactionTime === 'number') {
        transactionTime = new Date(transactionTime);
    } else {
        transactionTime = new Date(); // fallback to now
    }
    // Validate the date is valid
    if (isNaN(transactionTime.getTime())) {
        transactionTime = new Date();
    }

    if (Math.abs(parsedAmount - amount) > 1) {
        return res.status(400).json({
            success: false,
            message: `Amount must be exactly Ksh. ${amount.toLocaleString()}`
        });
    }

    try {
        const existingCodeRes = await pool.query('SELECT id FROM mpesa_codes WHERE mpesa_code = $1', [mpesaCode]);
        if (existingCodeRes.rows.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid M-PESA message (duplicate transaction code)'
            });
        }

        const interestRates = {
            'basic': 0.05,
            'premium': 0.08,
            'elite': 0.12
        };
        const rate = interestRates[tier] || 0.05;
        const dailyInterest = (amount * rate) / 365;

        await pool.query('INSERT INTO mpesa_codes (mpesa_code, transaction_type, user_id, amount) VALUES ($1, $2, $3, $4)',
            [mpesaCode, 'savings', userId, amount]);

        // Convert transactionTime to MySQL-compatible format (YYYY-MM-DD HH:MM:SS)
        const mysqlDateTime = transactionTime.toISOString().slice(0, 19).replace('T', ' ');

        const savingsDepositRes = await pool.query(
            `INSERT INTO savings_deposits 
       (user_id, amount, tier, mpesa_code, recipient_name, transaction_time, deposit_number) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [userId, amount, tier, mpesaCode, recipientName, mysqlDateTime, depositNumber]
        );
        const lastID = savingsDepositRes.rows[0].id;

        await pool.query('UPDATE users SET savingsBalance = savingsBalance + $1 WHERE id = $2', [amount, userId]);

        await pool.query(
            `INSERT INTO savings (user_id, amount, tier, interest_rate, daily_interest, total_balance) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
            [userId, amount, tier, rate, dailyInterest, amount]
        );

        const userRes = await pool.query('SELECT savingsHistory FROM users WHERE id = $1', [userId]);
        if (userRes.rows.length > 0) {
            try {
                const history = userRes.rows[0].savingshistory ? JSON.parse(userRes.rows[0].savingshistory) : [];
                history.push({
                    type: 'deposit',
                    amount: amount,
                    tier: tier,
                    date: new Date().toISOString(),
                    method: 'direct_deposit',
                    mpesaCode: mpesaCode
                });

                await pool.query('UPDATE users SET savingsHistory = $1 WHERE id = $2', [JSON.stringify(history), userId]);
            } catch (parseError) {
                console.error('âŒ Parse error:', parseError);
            }
        }

        const updatedUserRes = await pool.query('SELECT savingsBalance FROM users WHERE id = $1', [userId]);
        if (updatedUserRes.rows.length === 0) {
            return res.status(500).json({
                success: false,
                message: 'Failed to retrieve updated balance'
            });
        }

        res.json({
            success: true,
            message: 'Direct deposit recorded successfully',
            savingsBalance: parseFloat(updatedUserRes.rows[0].savingsbalance) || 0,
            depositId: lastID
        });

    } catch (error) {
        console.error('âŒ Savings deposit error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ===== START CAPTCHA WORK =====
app.post('/api/user/start-work', async (req, res) => {
    const { userId, taskAiNumber } = req.body;
    const taskType = normalizeTrainingTaskType(req.body.taskType);

    if (!userId || !taskAiNumber) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    if (!isValidTaskAiNumber(taskAiNumber)) {
        return res.status(400).json({ success: false, message: 'Invalid Task AI level' });
    }

    const aiKey = `AI_${taskAiNumber}`;
    try {
        const rowLock = pool.databaseClient === 'sqlite' ? '' : ' FOR UPDATE';
        const access = await withTransaction(async (client) => {
            const query = client.query.bind(client);
            const userRes = await query(`SELECT workTimers FROM users WHERE id = $1${rowLock}`, [userId]);
            if (!userRes.rows.length) return { status: 404, body: { success: false, message: 'User not found' } };

            const isUnlocked = await hasUnlockedTaskAi(userId, taskAiNumber, query);
            if (!isUnlocked) {
                return { status: 403, body: { success: false, message: 'This Task AI level is locked until its payment is independently verified.' } };
            }

            const accountAccessState = await getAccountAccessState(userId, query);
            if (accountAccessState.restricted) {
                return {
                    status: 403,
                    body: {
                        success: false,
                        message: accountAccessState.message,
                        withdrawalRestriction: toPublicRestriction(accountAccessState)
                    }
                };
            }

            const workTimers = parseTimerJson(userRes.rows[0].worktimers);
            const workTimer = normalizeCaptchaTimer(workTimers[aiKey]);
            if (workTimer.captchaCount >= CAPTCHA_LIMIT) {
                return {
                    status: 429,
                    body: {
                        success: false,
                        message: 'CAPTCHA limit reached for this level. Try again after the 8-hour window resets.',
                        captchaCount: workTimer.captchaCount,
                        maxCaptchas: CAPTCHA_LIMIT,
                        windowEndTime: new Date(workTimer.windowStart + CAPTCHA_WINDOW_MS).toISOString()
                    }
                };
            }

            workTimers[aiKey] = workTimer;
            await query('UPDATE users SET workTimers = $1 WHERE id = $2', [JSON.stringify(workTimers), userId]);
            return {
                status: 200,
                workTimer,
                windowEndTime: new Date(workTimer.windowStart + CAPTCHA_WINDOW_MS).toISOString()
            };
        });
        if (access.status !== 200) return res.status(access.status).json(access.body);

        const challenge = await createCaptchaChallenge(userId, taskAiNumber, taskType);
        res.json({
            success: true,
            message: 'Training task ready',
            question: challenge.question,
            scenario: challenge.scenario,
            rubric: challenge.rubric,
            instructions: challenge.instructions,
            requiresRationale: challenge.requiresRationale,
            rationaleHint: challenge.rationaleHint,
            challengeId: challenge.challengeId,
            taskType: challenge.taskType,
            inputMode: challenge.inputMode,
            options: challenge.options,
            // The annotation UI needs this object to create the <video> player.
            // Previously it was created in createCaptchaChallenge but omitted here.
            video: challenge.video,
            captchaCount: access.workTimer.captchaCount,
            maxCaptchas: CAPTCHA_LIMIT,
            windowEndTime: access.windowEndTime
        });

    } catch (error) {
        console.error('âŒ Start work error:', error);
        res.status(500).json({ success: false, message: 'Failed to start work' });
    }
});

// ===== COMPLETE CAPTCHA WORK (ADD EARNINGS) =====
app.post('/api/user/complete-work', async (req, res) => {
    const { userId, taskAiNumber, captchaAnswer, challengeId } = req.body;

    if (!userId || !taskAiNumber || captchaAnswer === undefined || !challengeId) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    if (!isValidTaskAiNumber(taskAiNumber)) {
        return res.status(400).json({ success: false, message: 'Invalid Task AI level' });
    }

    const taskRewards = {
        '1': 100, '2': 250, '3': 700,
        '4': 1500, '5': 2000, '6': 3000
    };
    const rewardAmount = taskRewards[taskAiNumber] || 0;

    try {
        const aiKey = `AI_${taskAiNumber}`;
        const rowLock = pool.databaseClient === 'sqlite' ? '' : ' FOR UPDATE';
        const outcome = await withTransaction(async (client) => {
            const query = client.query.bind(client);
            const userRes = await query(`SELECT workTimers FROM users WHERE id = $1${rowLock}`, [userId]);
            if (!userRes.rows.length) return { status: 404, body: { success: false, message: 'User not found' } };

            const isUnlocked = await hasUnlockedTaskAi(userId, taskAiNumber, query);
            if (!isUnlocked) {
                return { status: 403, body: { success: false, message: 'This Task AI level is locked until its payment is independently verified.' } };
            }

            const accountAccessState = await getAccountAccessState(userId, query);
            if (accountAccessState.restricted) {
                return {
                    status: 403,
                    body: {
                        success: false,
                        message: accountAccessState.message,
                        withdrawalRestriction: toPublicRestriction(accountAccessState)
                    }
                };
            }

            const verification = verifyCaptchaChallenge(challengeId, userId, taskAiNumber, captchaAnswer);
            if (!verification.valid) {
                return { status: 400, body: { success: false, message: verification.message || 'Incorrect or expired task submission' } };
            }

            const workTimers = parseTimerJson(userRes.rows[0].worktimers);
            const workTimer = normalizeCaptchaTimer(workTimers[aiKey]);
            if (workTimer.captchaCount >= CAPTCHA_LIMIT) {
                return {
                    status: 429,
                    body: {
                        success: false,
                        message: 'CAPTCHA limit reached for this level. Try again after the 8-hour window resets.',
                        captchaCount: workTimer.captchaCount,
                        maxCaptchas: CAPTCHA_LIMIT,
                        windowEndTime: new Date(workTimer.windowStart + CAPTCHA_WINDOW_MS).toISOString()
                    }
                };
            }

            workTimer.captchaCount += 1;
            const rewardAdded = workTimer.captchaCount === CAPTCHA_LIMIT ? rewardAmount : 0;
            workTimers[aiKey] = workTimer;
            const challengeHash = crypto.createHash('sha256').update(String(challengeId)).digest('hex');
            const question = verification.question || '';
            const options = Array.isArray(verification.options) ? verification.options : [];
            const questionKey = crypto.createHash('sha256').update(`${taskAiNumber}\n${question}`).digest('hex');

            // Record the unique challenge first so duplicate submissions cannot
            // leave partial annotation or training-metric writes behind.
            const recorded = await query(
                `INSERT INTO task_choice_responses
                    (challenge_hash, user_id, task_ai_number, question_key, question, response_value, options)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (challenge_hash) DO NOTHING
                 RETURNING id`,
                [challengeHash, userId, String(taskAiNumber), questionKey, question,
                    String(verification.responseValue || ''), JSON.stringify(options)]
            );
            if (!recorded.rows.length) {
                return { status: 409, body: { success: false, message: 'This task response has already been submitted.' } };
            }

            if (verification.annotations && verification.videoDatabaseId) {
                await query(`
                    INSERT INTO video_responses (challenge_id, user_id, video_id, user_annotations, expected_actions, accuracy_score)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [crypto.createHash('sha256').update(challengeId).digest('hex').slice(0, 48), userId,
                    verification.videoDatabaseId, JSON.stringify(verification.annotations),
                    JSON.stringify(verification.expectedSequences), verification.score.score]);
                await query(
                    `UPDATE ai_training_metrics
                     SET contributions = contributions + $1,
                         clips_annotated = clips_annotated + 1,
                         consensus_events = consensus_events + 1,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE task_ai_number = $2`,
                    [verification.annotations.length, String(taskAiNumber)]
                );
            }

            if (!verification.annotations) {
                await query(
                    `UPDATE ai_training_metrics
                     SET contributions = contributions + 1,
                         consensus_events = consensus_events + 1,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE task_ai_number = $1`,
                    [String(taskAiNumber)]
                );
            }

            await query('UPDATE users SET totalEarned = totalEarned + $1, workTimers = $2, lastActivity = CURRENT_TIMESTAMP WHERE id = $3',
                [rewardAdded, JSON.stringify(workTimers), userId]);

            let choiceStats = null;
            if (options.length) {
                const statsResult = await query(
                    `SELECT response_value AS value, COUNT(*)::int AS count
                     FROM task_choice_responses WHERE question_key = $1
                     GROUP BY response_value ORDER BY count DESC`,
                    [questionKey]
                );
                const totalResponses = statsResult.rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
                choiceStats = {
                    question,
                    totalResponses,
                    choices: statsResult.rows.map(row => ({ value: row.value, count: Number(row.count || 0), percentage: totalResponses ? Math.round(Number(row.count || 0) * 1000 / totalResponses) / 10 : 0 }))
                };
            }

            return {
                status: 200,
                hasAnnotations: Boolean(verification.annotations),
                body: {
                    success: true,
                    message: rewardAdded > 0
                        ? 'Training contribution cycle completed. Earnings added successfully.'
                        : 'Training contribution saved successfully.',
                    rewardAdded,
                    annotationScore: verification.score?.score ?? null,
                    captchaCount: workTimer.captchaCount,
                    maxCaptchas: CAPTCHA_LIMIT,
                    windowEndTime: new Date(workTimer.windowStart + CAPTCHA_WINDOW_MS).toISOString(),
                    choiceStats
                }
            };
        });
        if (outcome.status !== 200) return res.status(outcome.status).json(outcome.body);
        const trainingMetric = outcome.hasAnnotations ? await getTrainingMetric(taskAiNumber) : null;
        res.json({ ...outcome.body, trainingMetric });

    } catch (error) {
        console.error('âŒ Complete work error:', error);
        res.status(500).json({ success: false, message: 'Failed to update earnings' });
    }
});

// ===== WITHDRAWAL REQUEST =====
app.post('/api/user/withdraw', async (req, res) => {
    const { userId, amount, receivingNumber } = req.body;

    if (!userId || !amount || !receivingNumber) {
        return res.status(400).json({
            success: false,
            message: 'Missing required fields'
        });
    }

    const amountNum = parseFloat(amount);
    if (!isPositiveAmount(amountNum)) {
        return res.status(400).json({ success: false, message: 'Invalid amount' });
    }

    if (!validateWithdrawalTime()) {
        return res.status(400).json({
            success: false,
            message: 'Withdrawals are only allowed between 10:00 AM and 3:00 PM on weekdays'
        });
    }

    try {
        const rowLock = pool.databaseClient === 'sqlite' ? '' : ' FOR UPDATE';
        const outcome = await withTransaction(async (client) => {
            // Serialize requests for this account so two simultaneous submits
            // cannot both pass the first-withdrawal check or overspend the same balance.
            const userRes = await client.query(
                `SELECT totalEarned, expectedEarning FROM users WHERE id = $1${rowLock}`,
                [userId]
            );
            if (userRes.rows.length === 0) {
                return { status: 404, body: { success: false, message: 'User not found' } };
            }

            const user = userRes.rows[0];
            const query = client.query.bind(client);
            const registrationFee = await getLatestVerifiedRegistrationFee(userId, query);
            if (!isPositiveAmount(registrationFee)) {
                return { status: 400, body: { success: false, message: 'A verified registration payment is required before requesting a withdrawal.' } };
            }

            const accountAccessState = await getAccountAccessState(userId, query);
            if (accountAccessState.restricted) {
                return {
                    status: 403,
                    body: {
                        success: false,
                        message: accountAccessState.message,
                        withdrawalRestriction: toPublicRestriction(accountAccessState)
                    }
                };
            }

            const withdrawalCount = accountAccessState.withdrawalCount;
            const firstWithdrawalAmount = registrationFee * FIRST_WITHDRAWAL_RATE;
            if (withdrawalCount === 0 && Math.abs(amountNum - firstWithdrawalAmount) > 0.005) {
                return {
                    status: 400,
                    body: {
                        success: false,
                        message: `Your first withdrawal must be exactly Ksh. ${firstWithdrawalAmount.toLocaleString('en-KE', { maximumFractionDigits: 2 })}, which is 30% of your verified registration fee.`
                    }
                };
            }

            if (amountNum > parseFloat(user.totalearned)) {
                return { status: 400, body: { success: false, message: 'Insufficient balance' } };
            }

            // Check the NET barrier after this request is included. Checking
            // only the current state lets one large request jump several
            // referral barriers in a single step.
            if (withdrawalCount > 0) {
                const projectedAccountAccessState = await getAccountAccessState(
                    userId,
                    query,
                    { additionalWithdrawalAmount: amountNum }
                );
                if (projectedAccountAccessState.restricted) {
                    return {
                        status: 403,
                        body: {
                            success: false,
                            message: projectedAccountAccessState.message,
                            withdrawalRestriction: toPublicRestriction(projectedAccountAccessState)
                        }
                    };
                }
            }

            const expectedEarning = calculateExpectedEarning(amountNum);
            await query('UPDATE users SET totalEarned = totalEarned - $1 WHERE id = $2', [amountNum, userId]);
            const withdrawRes = await query(
                `INSERT INTO withdrawals (user_id, amount, expected_earning, receiving_number)
                 VALUES ($1, $2, $3, $4) RETURNING id`,
                [userId, amountNum, expectedEarning, receivingNumber]
            );
            const updatedUserRes = await query('SELECT totalEarned, expectedEarning FROM users WHERE id = $1', [userId]);
            if (updatedUserRes.rows.length === 0) throw new Error('Failed to retrieve updated balance');

            const balance = parseFloat(updatedUserRes.rows[0].totalearned) || 0;
            const updatedAccountAccessState = await getAccountAccessState(userId, query);
            return {
                status: 200,
                body: {
                    success: true,
                    message: 'Withdrawal request submitted successfully. Expect funds within 48 hours.',
                    withdrawalId: withdrawRes.rows[0].id,
                    balance,
                    expectedEarning: calculateExpectedEarning(balance),
                    withdrawalRestriction: toPublicRestriction(updatedAccountAccessState)
                }
            };
        });
        res.status(outcome.status).json(outcome.body);

    } catch (error) {
        console.error('âŒ Withdrawal error:', error);
        res.status(500).json({ success: false, message: 'Failed to process withdrawal' });
    }
});

// ===== LOAN APPLICATION =====
app.post('/api/user/apply-loan', async (req, res) => {
    const { userId, phone, idFront, idBack } = req.body;

    if (!userId || !phone || !idFront || !idBack) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    if (!isAllowedIdImage(idFront) || !isAllowedIdImage(idBack)) {
        return res.status(400).json({ success: false, message: 'ID images must be PNG, JPG, or WEBP data images' });
    }

    try {
        const userRes = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
        if (userRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const purchasesRes = await pool.query(
            `SELECT COUNT(DISTINCT task_ai_number) AS purchased_count
             FROM mpesa_transactions
             WHERE user_id = $1 AND status = 'completed' AND task_ai_number IN ('1', '2', '3')`,
            [userId]
        );
        const hasTaskAI1_3 = parseInt(purchasesRes.rows[0].purchased_count, 10) >= 3;

        if (!hasTaskAI1_3) {
            return res.status(400).json({
                success: false,
                message: 'Must buy at least Task AI 1 to Task AI 3 to be eligible for a loan'
            });
        }

        const loanRes = await pool.query(
            `INSERT INTO loan_applications (user_id, phone, id_front, id_back) 
       VALUES ($1, $2, $3, $4) RETURNING id`,
            [userId, phone, idFront, idBack]
        );

        res.json({
            success: true,
            message: 'System processing, wait for 48 to 72hrs for feedback',
            applicationId: loanRes.rows[0].id
        });

    } catch (error) {
        console.error('âŒ Loan application error:', error);
        res.status(500).json({ success: false, message: 'Failed to submit loan application' });
    }
});

// ===== SAVINGS DEPOSIT (DEDUCT METHOD) =====
app.post('/api/user/savings-deposit', async (req, res) => {
    const { userId, amount, tier, depositMethod } = req.body;

    if (!userId || !amount || !tier) {
        return res.status(400).json({
            success: false,
            message: 'Missing required fields'
        });
    }

    const amountNum = parseFloat(amount);
    const interestRates = {
        'basic': 0.05,
        'premium': 0.08,
        'elite': 0.12
    };
    const rate = interestRates[tier] || 0.05;
    const dailyInterest = (amountNum * rate) / 365;

    if (depositMethod === 'deduct') {
        try {
            const userRes = await pool.query('SELECT totalEarned FROM users WHERE id = $1', [userId]);
            if (userRes.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'User not found'
                });
            }

            const user = userRes.rows[0];
            if (amountNum > parseFloat(user.totalearned)) {
                return res.status(400).json({
                    success: false,
                    message: 'Insufficient balance in total earned'
                });
            }

            // In PostgreSQL we don't need db.serialize(), we just await the queries
            await pool.query('UPDATE users SET totalEarned = totalEarned - $1 WHERE id = $2', [amountNum, userId]);
            await pool.query('UPDATE users SET savingsBalance = savingsBalance + $1 WHERE id = $2', [amountNum, userId]);

            await pool.query(
                `INSERT INTO savings (user_id, amount, tier, interest_rate, daily_interest, total_balance) 
         VALUES ($1, $2, $3, $4, $5, $6)`,
                [userId, amountNum, tier, rate, dailyInterest, amountNum]
            );

            const historyRes = await pool.query('SELECT savingsHistory FROM users WHERE id = $1', [userId]);
            if (historyRes.rows.length > 0) {
                try {
                    const history = historyRes.rows[0].savingshistory ? JSON.parse(historyRes.rows[0].savingshistory) : [];
                    history.push({
                        type: 'deposit',
                        amount: amountNum,
                        tier: tier,
                        date: new Date().toISOString(),
                        method: 'deduct_from_earned'
                    });

                    await pool.query('UPDATE users SET savingsHistory = $1 WHERE id = $2', [JSON.stringify(history), userId]);
                } catch (parseError) {
                    console.error('âŒ Parse error:', parseError);
                }
            }

            const updatedUserRes = await pool.query('SELECT savingsBalance FROM users WHERE id = $1', [userId]);
            res.json({
                success: true,
                message: 'Savings deposited successfully',
                savingsBalance: parseFloat(updatedUserRes.rows[0].savingsbalance) || 0,
                totalEarned: 0
            });

        } catch (error) {
            console.error('âŒ Savings deposit error:', error);
            res.status(500).json({ success: false, message: 'Server error' });
        }
    } else {
        return res.status(400).json({
            success: false,
            message: 'Use direct deposit endpoint for M-PESA deposits'
        });
    }
});

// ===== SAVINGS WITHDRAWAL =====
app.post('/api/user/savings-withdraw', async (req, res) => {
    const { userId, amount } = req.body;

    if (!userId || !amount) {
        return res.status(400).json({
            success: false,
            message: 'Missing required fields'
        });
    }

    const amountNum = parseFloat(amount);
    if (!isPositiveAmount(amountNum)) {
        return res.status(400).json({ success: false, message: 'Invalid withdrawal amount' });
    }

    try {
        const rowLock = pool.databaseClient === 'sqlite' ? '' : ' FOR UPDATE';
        const outcome = await withTransaction(async (client) => {
            const query = client.query.bind(client);
            const userRes = await query(`SELECT savingsBalance, savingsHistory FROM users WHERE id = $1${rowLock}`, [userId]);
            if (!userRes.rows.length) return { status: 404, body: { success: false, message: 'User not found' } };

            const accountAccessState = await getAccountAccessState(userId, query);
            if (accountAccessState.restricted) {
                return {
                    status: 403,
                    body: {
                        success: false,
                        message: accountAccessState.message,
                        withdrawalRestriction: toPublicRestriction(accountAccessState)
                    }
                };
            }

            if (amountNum > parseFloat(userRes.rows[0].savingsbalance)) {
                return { status: 400, body: { success: false, message: 'Insufficient savings balance' } };
            }

            await query('UPDATE users SET savingsBalance = savingsBalance - $1 WHERE id = $2', [amountNum, userId]);
            await query('INSERT INTO savings_withdrawals (user_id, amount) VALUES ($1, $2)', [userId, amountNum]);

            try {
                const history = userRes.rows[0].savingshistory ? JSON.parse(userRes.rows[0].savingshistory) : [];
                history.push({ type: 'withdrawal', amount: amountNum, date: new Date().toISOString(), status: 'pending' });
                await query('UPDATE users SET savingsHistory = $1 WHERE id = $2', [JSON.stringify(history), userId]);
            } catch (parseError) {
                console.error('Savings withdrawal history parse error:', parseError);
            }

            const updatedUserRes = await query('SELECT savingsBalance FROM users WHERE id = $1', [userId]);
            return {
                status: 200,
                body: {
                    success: true,
                    message: 'Withdrawn amount to be accredited to login phone number. System processing withdrawal, expect funds within 48hrs',
                    savingsBalance: parseFloat(updatedUserRes.rows[0]?.savingsbalance) || 0
                }
            };
        });
        res.status(outcome.status).json(outcome.body);

    } catch (error) {
        console.error('âŒ Savings withdrawal error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ===== GET USER M-PESA SUBMISSIONS =====
app.get('/api/user/:userId/mpesa-submissions', async (req, res) => {
    const userId = req.params.userId;
    const page = readPage(req, 250);

    try {
        const result = await pool.query(
            `SELECT * FROM mpesa_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
            [userId, page.limit, page.offset]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('âŒ M-PESA query error:', error);
        res.status(500).json([]);
    }
});

// ===== GET USER WITHDRAWALS =====
app.get('/api/user/:userId/withdrawals', async (req, res) => {
    const userId = req.params.userId;
    const page = readPage(req, 250);

    try {
        const result = await pool.query(
            `SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY submitted_at DESC LIMIT $2 OFFSET $3`,
            [userId, page.limit, page.offset]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('âŒ Withdrawals query error:', error);
        res.status(500).json([]);
    }
});

// ===== GET USER LOANS =====
app.get('/api/user/:userId/loans', async (req, res) => {
    const userId = req.params.userId;
    const page = readPage(req, 250);

    try {
        const result = await pool.query(
            `SELECT * FROM loan_applications WHERE user_id = $1 ORDER BY submitted_at DESC LIMIT $2 OFFSET $3`,
            [userId, page.limit, page.offset]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('âŒ Loans query error:', error);
        res.status(500).json([]);
    }
});

// ===== GET USER SAVINGS HISTORY =====
app.get('/api/user/:userId/savings-history', async (req, res) => {
    const userId = req.params.userId;
    const page = readPage(req, 250);

    try {
        const result = await pool.query(
            `SELECT * FROM savings WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
            [userId, page.limit, page.offset]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('âŒ Savings query error:', error);
        res.status(500).json([]);
    }
});

// ===== GET ALL USERS =====
app.get('/api/users', requireLocalControlTower, async (req, res) => {
    const page = readPage(req, 500);
    try {
        const result = await pool.query(`
            SELECT u.id, u.phone, u.totalEarned, u.expectedEarning, u.savingsBalance,
                   (SELECT COUNT(*) FROM mpesa_transactions m WHERE m.user_id = u.id) AS mpesa_count
            FROM users u ORDER BY u.id DESC LIMIT $1 OFFSET $2`, [page.limit, page.offset]);
        res.json(result.rows || []);
    } catch (error) {
        console.error('âŒ Users fetch error:', error);
        res.status(500).json([]);
    }
});

// ===== UPDATE WORK-QUOTA TIMER STATUS =====
app.post('/api/timer/update', requireLocalControlTower, async (req, res) => {
    const { transactionId, timerType, paused } = req.body;

    if (!transactionId || !timerType || paused === undefined) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
    }
    if (timerType !== '8hr') {
        return res.status(400).json({ success: false, message: 'Only the 8-hour work quota can be paused.' });
    }

    try {
        const txRes = await pool.query(
            'SELECT user_id, task_ai_number FROM mpesa_transactions WHERE id = $1',
            [transactionId]
        );
        if (txRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Transaction not found' });
        }

        const { user_id: userId, task_ai_number: taskAiNumber } = txRes.rows[0];
        const aiKey = `AI_${taskAiNumber}`;

        const userRes = await pool.query('SELECT workTimers FROM users WHERE id = $1', [userId]);
        if (userRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const workTimers = userRes.rows[0].worktimers ? JSON.parse(userRes.rows[0].worktimers) : {};

        const timerObj = workTimers[aiKey];
        const now = Date.now();

        if (timerObj && timerObj.startTime && !timerObj.completed) {
            if (paused) {
                if (!timerObj.paused) {
                    timerObj.paused = true;
                    timerObj.pausedAt = now;
                }
            } else {
                if (timerObj.paused && timerObj.pausedAt) {
                    const pausedDuration = now - timerObj.pausedAt;
                    timerObj.startTime = timerObj.startTime + pausedDuration;
                    timerObj.paused = false;
                    timerObj.pausedAt = null;
                }
            }
        }

        workTimers[aiKey] = timerObj;

        await pool.query(
            'UPDATE users SET workTimers = $1 WHERE id = $2',
            [JSON.stringify(workTimers), userId]
        );

        await pool.query(
            'UPDATE mpesa_transactions SET timer_8hr_paused = $1 WHERE id = $2',
            [paused ? true : false, transactionId]
        );

        res.json({
            success: true,
            message: `Timer ${paused ? 'paused' : 'resumed'} successfully`
        });
    } catch (error) {
        console.error('âŒ Timer update error:', error);
        res.status(500).json({ success: false, message: 'Failed to update timer' });
    }
});

// ===== CHECK TIMER STATUS =====
app.get('/api/user/:userId/timers', async (req, res) => {
    const userId = req.params.userId;

    try {
        const result = await pool.query('SELECT workTimers FROM users WHERE id = $1', [userId]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const user = result.rows[0];
        const workTimers = user.worktimers ? JSON.parse(user.worktimers) : {};

        let updated = false;

        for (const key of Object.keys(workTimers)) {
            const timer = workTimers[key];
            if (timer.startTime || timer.windowStart) {
                const normalizedTimer = normalizeCaptchaTimer(timer);
                if (JSON.stringify(normalizedTimer) !== JSON.stringify(timer)) {
                    workTimers[key] = normalizedTimer;
                    updated = true;
                }
            }
        }

        if (updated) {
            await pool.query('UPDATE users SET workTimers = $1 WHERE id = $2',
                [JSON.stringify(workTimers), userId]);
        }

        res.json({
            success: true,
            aiTimers: {},
            workTimers: workTimers,
            updated: updated
        });

    } catch (error) {
        console.error('âŒ Check timers error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ===== UPDATE SAVINGS INTEREST =====
app.post('/api/user/update-savings-interest', async (req, res) => {
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({
            success: false,
            message: 'User ID required'
        });
    }

    try {
        const savingsRes = await pool.query('SELECT id, daily_interest, last_interest_update FROM savings WHERE user_id = $1', [userId]);
        const now = new Date();
        let totalInterest = 0;

        for (const saving of savingsRes.rows) {
            const lastUpdate = new Date(saving.last_interest_update);
            const daysDiff = Math.floor((now - lastUpdate) / (1000 * 60 * 60 * 24));

            if (daysDiff > 0) {
                const interestToAdd = parseFloat(saving.daily_interest) * daysDiff;
                totalInterest += interestToAdd;

                await pool.query('UPDATE savings SET total_balance = total_balance + $1, last_interest_update = CURRENT_TIMESTAMP WHERE id = $2',
                    [interestToAdd, saving.id]);
            }
        }

        if (totalInterest > 0) {
            await pool.query('UPDATE users SET savingsBalance = savingsBalance + $1 WHERE id = $2',
                [totalInterest, userId]);
        }

        const userRes = await pool.query('SELECT savingsBalance FROM users WHERE id = $1', [userId]);
        if (userRes.rows.length === 0) {
            return res.status(500).json({
                success: false,
                message: 'Failed to retrieve savings balance'
            });
        }

        res.json({
            success: true,
            message: 'Savings interest updated',
            interestAdded: totalInterest,
            savingsBalance: parseFloat(userRes.rows[0].savingsbalance) || 0
        });

    } catch (error) {
        console.error('âŒ Update savings interest error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update interest'
        });
    }
});

// ===== GET RECENT SUBMISSIONS =====
app.get('/api/recent-submissions', requireAuth, async (req, res) => {
    try {
        // interval '1 hour' in PostgreSQL
        const result = await pool.query(`
            SELECT 'mpesa' as type, user_id, created_at FROM mpesa_transactions WHERE created_at > NOW() - interval '1 hour'
            UNION ALL
            SELECT 'withdrawal' as type, user_id, submitted_at as created_at FROM withdrawals WHERE submitted_at > NOW() - interval '1 hour'
            UNION ALL
            SELECT 'loan' as type, user_id, submitted_at as created_at FROM loan_applications WHERE submitted_at > NOW() - interval '1 hour'
            ORDER BY created_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('âŒ Recent submissions error:', error);
        res.json([]);
    }
});

// ===== START PROCESSING =====
app.post('/api/start-processing', requireAuth, async (req, res) => {
    const { userId } = req.body;

    try {
        const result = await pool.query(
            `UPDATE withdrawals SET status = 'processing', processed_at = CURRENT_TIMESTAMP 
             WHERE status = 'pending' AND user_id = $1`,
            [userId]
        );

        res.json({
            success: true,
            message: 'Processing started successfully',
            rowsAffected: result.rowCount
        });
    } catch (error) {
        console.error('âŒ Start processing error:', error);
        res.status(500).json({ success: false, message: 'Failed to start processing' });
    }
});

// ===== CLEAR USER DATA =====
app.delete('/api/user/:userId/clear/:dataType', async (req, res) => {
    const { userId, dataType } = req.params;
    const tables = {
        'mpesa': 'mpesa_transactions',
        'withdrawals': 'withdrawals',
        'loans': 'loan_applications',
        'savings': 'savings'
    };

    const table = tables[dataType];
    if (!table) {
        return res.status(400).json({ success: false, message: 'Invalid data type' });
    }

    try {
        let result;
        if (table === 'mpesa_transactions') {
            result = await pool.query('DELETE FROM mpesa_transactions WHERE user_id = $1', [userId]);
        } else if (table === 'withdrawals') {
            result = await pool.query('DELETE FROM withdrawals WHERE user_id = $1', [userId]);
        } else if (table === 'loan_applications') {
            result = await pool.query('DELETE FROM loan_applications WHERE user_id = $1', [userId]);
        } else {
            result = await pool.query('DELETE FROM savings WHERE user_id = $1', [userId]);
        }
        res.json({
            success: true,
            message: `${dataType} data cleared successfully`,
            rowsDeleted: result.rowCount
        });
    } catch (error) {
        console.error(`âŒ Clear ${dataType} error:`, error);
        res.status(500).json({ success: false, message: `Failed to clear ${dataType}` });
    }
});

// ===== GET USER WITHDRAWAL HISTORY =====
app.get('/api/user/:userId/withdrawal-history', async (req, res) => {
    const userId = req.params.userId;

    try {
        const result = await pool.query(
            `SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY submitted_at DESC`,
            [userId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('âŒ Withdrawal history error:', error);
        res.status(500).json([]);
    }
});

// ===== GET USER SAVINGS WITHDRAWALS =====
app.get('/api/user/:userId/savings-withdrawals', async (req, res) => {
    const userId = req.params.userId;

    try {
        const result = await pool.query(
            `SELECT * FROM savings_withdrawals WHERE user_id = $1 ORDER BY submitted_at DESC`,
            [userId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('âŒ Savings withdrawals error:', error);
        res.status(500).json([]);
    }
});

// ===== GET USER REFERRAL HISTORY =====
app.get('/api/user/:userId/referral-history', async (req, res) => {
    const userId = req.params.userId;

    try {
        const result = await pool.query(
            `SELECT r.*, u.phone as referred_phone 
             FROM referrals r
             LEFT JOIN users u ON r.referred_id = u.id
             WHERE r.referrer_id = $1 
             ORDER BY r.created_at DESC`,
            [userId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('âŒ Referral history error:', error);
        res.status(500).json([]);
    }
});

// ===== GET USER REFERRAL STATS =====
app.get('/api/user/:userId/referral-stats', async (req, res) => {
    const userId = req.params.userId;

    try {
        const result = await pool.query(
            `SELECT 
                COUNT(*) as total_referrals,
                SUM(CASE WHEN reward_paid = true THEN 1 ELSE 0 END) as completed_referrals,
                SUM(CASE WHEN reward_paid = false THEN 1 ELSE 0 END) as pending_referrals,
                SUM(reward_amount) as total_rewards,
                SUM(CASE WHEN reward_paid = true THEN reward_amount ELSE 0 END) as paid_rewards
             FROM referrals 
             WHERE referrer_id = $1`,
            [userId]
        );

        const stats = result.rows[0];
        res.json(stats || {
            total_referrals: 0,
            completed_referrals: 0,
            pending_referrals: 0,
            total_rewards: 0,
            paid_rewards: 0
        });
    } catch (error) {
        console.error('âŒ Referral stats error:', error);
        res.status(500).json({});
    }
});

// ===== ADMIN ENDPOINTS =====

// Get recipient names
app.get('/api/admin/recipient-names', requireAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name FROM recipient_names ORDER BY name');
        res.json(result.rows);
    } catch (error) {
        console.error('âŒ Recipient names error:', error);
        res.status(500).json([]);
    }
});

// Add recipient name
app.post('/api/admin/recipient-names', requireAuth, async (req, res) => {
    const { name } = req.body;

    if (!name) {
        return res.status(400).json({ success: false, message: 'Name required' });
    }

    try {
        await repairMysqlIntegerId('recipient_names');
        await pool.query('INSERT INTO recipient_names (name) VALUES ($1)', [name.toUpperCase()]);
        res.json({
            success: true,
            message: 'Recipient name added successfully'
        });
    } catch (error) {
        console.error('âŒ Add recipient name error:', error);
        res.status(500).json({ success: false, message: 'Failed to add recipient name' });
    }
});

// Remove recipient name
app.delete('/api/admin/recipient-names/:id', requireAuth, async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query('DELETE FROM recipient_names WHERE id = $1', [id]);
        res.json({
            success: true,
            message: 'Recipient name removed successfully',
            rowsDeleted: result.rowCount
        });
    } catch (error) {
        console.error('âŒ Remove recipient name error:', error);
        res.status(500).json({ success: false, message: 'Failed to remove recipient name' });
    }
});

// Get deposit numbers (admin)
app.get('/api/admin/deposit-numbers', requireControlTowerAccess, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, phone_number, active FROM deposit_numbers ORDER BY id');
        res.json(result.rows);
    } catch (error) {
        console.error('âŒ Admin deposit numbers error:', error);
        res.status(500).json([]);
    }
});

// Add deposit number (admin)
app.post('/api/admin/deposit-numbers', requireControlTowerAccess, async (req, res) => {
    const { phoneNumber } = req.body;

    const formattedPhoneNumber = formatPhoneNumber(phoneNumber);
    if (!formattedPhoneNumber || !isSupportedPhoneNumber(formattedPhoneNumber)) {
        return res.status(400).json({ success: false, message: 'Enter a valid Kenyan mobile number.' });
    }

    try {
        await repairDepositNumbersMysqlSchema();

        const existing = await pool.query('SELECT id FROM deposit_numbers WHERE phone_number = $1 LIMIT 1', [formattedPhoneNumber]);
        if (existing.rows.length) {
            return res.status(409).json({ success: false, message: 'Deposit number already exists.' });
        }

        await pool.query('INSERT INTO deposit_numbers (phone_number, active) VALUES ($1, true)', [formattedPhoneNumber]);
        return res.json({
            success: true,
            message: 'Deposit number added successfully'
        });
    } catch (error) {
        console.error('âŒ Add deposit number error:', error);
        const message = /SQLITE_CONSTRAINT|duplicate key|ER_DUP_ENTRY|already exists|UNIQUE|ER_NO_DEFAULT_FOR_FIELD|Field 'id' doesn't have a default value/i.test(String(error?.message || error))
            ? (String(error?.message || '').includes('id') ? 'Deposit number table needs its id column repaired to AUTO_INCREMENT.' : 'Deposit number already exists.')
            : 'Failed to add deposit number';
        return res.status(message === 'Deposit number already exists.' ? 409 : 500).json({ success: false, message });
    }
});

// Remove deposit number (admin)
app.delete('/api/admin/deposit-numbers/:id', requireControlTowerAccess, async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query('DELETE FROM deposit_numbers WHERE id = $1', [id]);
        res.json({
            success: true,
            message: 'Deposit number removed successfully',
            rowsDeleted: result.rowCount
        });
    } catch (error) {
        console.error('âŒ Remove deposit number error:', error);
        res.status(500).json({ success: false, message: 'Failed to remove deposit number' });
    }
});

// ===== DATABASE INIT =====
testDatabaseConnection();

// ===== VIDEO TASK ENDPOINTS =====

// Get video stream
app.get('/api/video/:videoId/stream', async (req, res) => {
    try {
        const { videoId } = req.params;
        
        const videoRes = await pool.query('SELECT filename FROM videos WHERE video_id = $1', [videoId]);
        if (!videoRes.rows || videoRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Video not found' });
        }

        const filename = videoRes.rows[0].filename;
        const videoPath = path.join(__dirname, 'videos', filename);

        // Send video file with proper MIME type and caching headers
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        // Some imported source clips begin with ".trashed-". Express hides
        // dotfiles by default, so explicitly allow the database-selected file.
        res.sendFile(videoPath, { dotfiles: 'allow' }, (err) => {
            if (err && res.headersSent === false) {
                return res.status(404).json({ success: false, message: 'File not found' });
            }
        });
    } catch (error) {
        console.error('Error serving video:', error);
        res.status(500).json({ success: false, message: 'Failed to load video' });
    }
});

// Get video metadata
app.get('/api/video/:videoId/metadata', async (req, res) => {
    try {
        const { videoId } = req.params;
        
        const videoRes = await pool.query(`
            SELECT id, video_id, title, duration, resolution, fps, difficulty, action_sequences 
            FROM videos 
            WHERE video_id = $1 AND status = 'active'
        `, [videoId]);

        if (!videoRes.rows || videoRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Video not found' });
        }

        const video = videoRes.rows[0];
        const actionSequences = typeof video.action_sequences === 'string'
            ? JSON.parse(video.action_sequences)
            : video.action_sequences;

        res.json({
            success: true,
            videoId: video.video_id,
            title: video.title,
            duration: video.duration,
            resolution: video.resolution,
            fps: video.fps,
            difficulty: video.difficulty,
            actionSequences: actionSequences,
            streamUrl: `/api/video/${videoId}/stream`
        });
    } catch (error) {
        console.error('Error fetching video metadata:', error);
        res.status(500).json({ success: false, message: 'Failed to load video metadata' });
    }
});

// List all available videos
app.get('/api/videos', async (req, res) => {
    try {
        const videosRes = await pool.query(`
            SELECT video_id, title, duration, difficulty, status, task_ai_number, focus, prompt
            FROM videos 
            WHERE status = 'active'
            ORDER BY title ASC
        `);

        res.json({
            success: true,
            videos: videosRes.rows || [],
            count: (videosRes.rows || []).length
        });
    } catch (error) {
        console.error('Error fetching videos list:', error);
        res.status(500).json({ success: false, message: 'Failed to load videos list' });
    }
});

// ===== START SERVER =====
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`
    â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—
    â•‘         toloka SERVER STARTED           â•‘
    â• â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•£
    â•‘  ðŸŒ Local: http://localhost:${PORT}      â•‘
    â•‘  ðŸŒ Network: http://172.16.112.54:${PORT} â•‘
    â•‘  ðŸ“Š Database: ${String(pool.databaseClient || 'postgres').toUpperCase()}                â•‘
    â•‘  â° Timezone: EAT (UTC+3)               â•‘
    â•‘  âœ… Authentication: Ready               â•‘
    â•‘  âœ… Timers: Backend Controlled          â•‘
    â•‘  âœ… M-PESA Validation: Complete         â•‘
    â•‘  âœ… Admin Management: Ready             â•‘
    â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
    `);
});

// Tuned for a reverse proxy/load balancer. Individual production instances
// remain stateless and can be drained safely before a deploy or autoscale-in.
server.keepAliveTimeout = Number(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS || 65000);
server.headersTimeout = Number(process.env.HTTP_HEADERS_TIMEOUT_MS || 66000);

let isShuttingDown = false;
async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n${signal} received; draining Toloka API...`);
    server.close(async () => {
        try { await pool.end(); } catch (error) { console.error('Database pool shutdown error:', error); }
        process.exit(0);
    });
    setTimeout(() => process.exit(1), Number(process.env.SHUTDOWN_TIMEOUT_MS || 30000)).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

