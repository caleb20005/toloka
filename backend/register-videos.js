/**
 * Registers the supplied CLIPS videos as action-sequence training tasks.
 * Times are in seconds; duration is stored in milliseconds.
 */
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const CLIP_DURATION_MS = 10010;
const CLIP_DURATION_SECONDS = CLIP_DURATION_MS / 1000;
// `backend/videos` is the deployed source of truth. The application serves
// clips from this directory, so it must also be the first directory scanned
// for database registration. TOLOKA_VIDEO_DIR remains an optional import
// location for adding clips before they are copied into the deployment.
const DEPLOYED_VIDEO_DIR = path.join(__dirname, 'videos');
const LEGACY_EXTERNAL_VIDEO_DIR = 'C:\\Users\\Dubai Enterprise\\Videos';
const EXTERNAL_VIDEO_DIR = String(process.env.TOLOKA_VIDEO_DIR || LEGACY_EXTERNAL_VIDEO_DIR).trim();
const VIDEO_FOCUSES = [
  { taskAiNumber: '1', focus: 'object identification', title: 'Identify objects and their attributes', prompt: 'Mark the time range where each important object appears, then label its colour, category, or position.' },
  { taskAiNumber: '2', focus: 'human gestures', title: 'Recognise gestures and intent', prompt: 'Mark each meaningful human gesture and describe the intent it communicates.' },
  { taskAiNumber: '3', focus: 'fine-grained actions', title: 'Label fine-grained actions', prompt: 'Mark each distinct action boundary and label the physical action precisely.' },
  { taskAiNumber: '4', focus: 'safety and risk cues', title: 'Spot safety-relevant events', prompt: 'Mark events that change the safety context and describe the visible cue.' },
  { taskAiNumber: '5', focus: 'ordered motion sequences', title: 'Annotate ordered motion sequences', prompt: 'Mark every movement in order with accurate start and end times.' },
  { taskAiNumber: '6', focus: 'mood and social context', title: 'Interpret mood and social context', prompt: 'Mark visible expressions or gestures and describe the observable mood cue without guessing private thoughts.' }
];

// These labels were reviewed against the source clips, not inferred from filenames.
const videoClipsData = [
  {
    filename: 'DOOR.mp4', videoId: 'VID_DOOR', title: 'Open an interior door', difficulty: 'easy',
    actionSequences: [
      { startTime: 0.0, endTime: 2.3, label: 'Reaching toward the door handle', keywords: ['reach', 'approach', 'extend'] },
      { startTime: 2.3, endTime: 3.7, label: 'Grasping the door handle', keywords: ['grasp', 'grab', 'hold', 'handle'] },
      { startTime: 3.7, endTime: 5.1, label: 'Turning the handle downward', keywords: ['turn', 'rotate', 'twist', 'press'] },
      { startTime: 5.1, endTime: 6.8, label: 'Pulling the door open', keywords: ['pull', 'open', 'swing'] },
      { startTime: 6.8, endTime: 8.0, label: 'Releasing the handle and withdrawing the hand', keywords: ['release', 'withdraw', 'move away'] }
    ]
  },
  {
    filename: 'WINDOW.mp4', videoId: 'VID_WINDOW', title: 'Slide a window open', difficulty: 'medium',
    actionSequences: [
      { startTime: 0.9, endTime: 2.3, label: 'Reaching toward the window handle', keywords: ['reach', 'approach', 'extend'] },
      { startTime: 2.3, endTime: 3.6, label: 'Grasping the window handle', keywords: ['grasp', 'grab', 'hold', 'handle'] },
      { startTime: 3.6, endTime: 4.8, label: 'Unlocking or turning the window handle', keywords: ['unlock', 'turn', 'rotate', 'twist'] },
      { startTime: 4.8, endTime: 7.2, label: 'Sliding the window panel open', keywords: ['slide', 'open', 'push', 'pull'] },
      { startTime: 7.2, endTime: 8.2, label: 'Releasing the window handle', keywords: ['release', 'withdraw', 'let go'] }
    ]
  },
  {
    filename: 'LIGHT.mp4', videoId: 'VID_LIGHT', title: 'Turn on a light and enter the room', difficulty: 'easy',
    actionSequences: [
      { startTime: 0.5, endTime: 1.4, label: 'Reaching toward the light switch', keywords: ['reach', 'approach', 'extend'] },
      { startTime: 1.4, endTime: 2.3, label: 'Toggling the light switch on', keywords: ['toggle', 'switch', 'press', 'turn on'] },
      { startTime: 2.3, endTime: 3.1, label: 'Withdrawing the hand after the light turns on', keywords: ['withdraw', 'release', 'move away'] },
      { startTime: 5.8, endTime: 7.4, label: 'Walking into the lit room', keywords: ['walk', 'enter', 'step'] },
      { startTime: 7.4, endTime: 9.2, label: 'Stopping and looking into the room', keywords: ['stop', 'look', 'observe', 'stand'] }
    ]
  },
  {
    filename: 'PAGE_TURNING.mp4', videoId: 'VID_PAGE_TURNING', title: 'Turn a book page', difficulty: 'easy',
    actionSequences: [
      { startTime: 0.8, endTime: 2.4, label: 'Reaching toward the page corner', keywords: ['reach', 'approach', 'extend'] },
      { startTime: 2.4, endTime: 3.7, label: 'Pinching the page corner', keywords: ['pinch', 'grasp', 'grab', 'corner'] },
      { startTime: 3.7, endTime: 5.7, label: 'Lifting and flipping the page over', keywords: ['lift', 'flip', 'turn', 'page'] },
      { startTime: 5.7, endTime: 8.3, label: 'Smoothing the turned page flat', keywords: ['smooth', 'flatten', 'press', 'page'] },
      { startTime: 8.3, endTime: 9.4, label: 'Moving the hand away from the book', keywords: ['withdraw', 'release', 'move away'] }
    ]
  },
  {
    filename: 'WATER_BOTTLE.mp4', videoId: 'VID_WATER_BOTTLE', title: 'Pick up and set down a water bottle', difficulty: 'easy',
    actionSequences: [
      { startTime: 1.1, endTime: 2.5, label: 'Reaching toward the water bottle', keywords: ['reach', 'approach', 'extend'] },
      { startTime: 2.5, endTime: 3.8, label: 'Grasping the bottle around its middle', keywords: ['grasp', 'grab', 'hold', 'bottle'] },
      { startTime: 3.8, endTime: 5.2, label: 'Lifting the bottle off the table', keywords: ['lift', 'raise', 'pick up'] },
      { startTime: 5.2, endTime: 7.6, label: 'Holding and inspecting the bottle', keywords: ['hold', 'inspect', 'look', 'rotate'] },
      { startTime: 7.6, endTime: 9.3, label: 'Lowering the bottle back to the table', keywords: ['lower', 'set down', 'place'] }
    ]
  },
  {
    filename: 'COFFEE.mp4', videoId: 'VID_COFFEE', title: 'Lift and set down a cup of coffee', difficulty: 'easy',
    actionSequences: [
      { startTime: 0.5, endTime: 1.5, label: 'Reaching toward the cup handle', keywords: ['reach', 'approach', 'extend'] },
      { startTime: 1.5, endTime: 2.1, label: 'Grasping the cup handle', keywords: ['grasp', 'grab', 'hold', 'handle'] },
      { startTime: 2.1, endTime: 3.0, label: 'Lifting the cup', keywords: ['lift', 'raise', 'pick up'] },
      { startTime: 3.0, endTime: 4.4, label: 'Lowering the cup back to the table', keywords: ['lower', 'set down', 'place'] },
      { startTime: 5.0, endTime: 8.7, label: 'Reaching for and steadying the cup again', keywords: ['reach', 'grasp', 'hold', 'steady'] }
    ]
  },
  {
    filename: 'MAKING_COFFEE.mp4', videoId: 'VID_MAKING_COFFEE', title: 'Prepare and stir coffee', difficulty: 'hard',
    actionSequences: [
      { startTime: 1.5, endTime: 3.1, label: 'Adding coffee with a spoon', keywords: ['add', 'scoop', 'spoon', 'coffee'] },
      { startTime: 3.1, endTime: 4.7, label: 'Stirring the cup', keywords: ['stir', 'mix', 'spoon'] },
      { startTime: 4.7, endTime: 5.8, label: 'Positioning the kettle over the cup', keywords: ['position', 'kettle', 'pour'] },
      { startTime: 5.8, endTime: 6.9, label: 'Pouring hot water into the cup', keywords: ['pour', 'water', 'fill'] },
      { startTime: 7.5, endTime: 9.1, label: 'Stirring the prepared coffee', keywords: ['stir', 'mix', 'coffee'] }
    ]
  },
  {
    filename: 'LAB.mp4', videoId: 'VID_LAB', title: 'Adjust a microscope and view the sample', difficulty: 'hard',
    actionSequences: [
      { startTime: 1.6, endTime: 2.8, label: 'Reaching toward the microscope controls', keywords: ['reach', 'approach', 'control'] },
      { startTime: 2.8, endTime: 4.3, label: 'Positioning the sample slide on the stage', keywords: ['position', 'slide', 'stage', 'sample'] },
      { startTime: 4.3, endTime: 6.2, label: 'Adjusting the microscope focus control', keywords: ['adjust', 'focus', 'turn', 'knob'] },
      { startTime: 6.2, endTime: 7.0, label: 'Withdrawing the hand from the microscope', keywords: ['withdraw', 'release', 'move away'] },
      { startTime: 7.0, endTime: 10.0, label: 'Viewing the sample through the microscope', keywords: ['view', 'observe', 'sample', 'microscope'] }
    ]
  }
];

async function copyClipToVideoDirectory(clip) {
  const destinationDir = DEPLOYED_VIDEO_DIR;
  const destination = path.join(destinationDir, clip.filename);
  await fs.mkdir(destinationDir, { recursive: true });

  // Curated clips can already be in the deployed directory. Prefer that
  // durable copy so production does not depend on a separate CLIPS folder.
  let source = clip.sourcePath;
  if (!source) {
    try {
      await fs.stat(destination);
      source = destination;
    } catch (_) {
      source = path.join(__dirname, '..', 'CLIPS', clip.filename);
    }
  }

  const sourceStats = await fs.stat(source);
  let destinationStats = null;
  try { destinationStats = await fs.stat(destination); } catch (_) { /* copy below */ }
  const sourceIsDestination = path.resolve(source) === path.resolve(destination);
  if (!sourceIsDestination && (!destinationStats || destinationStats.size !== sourceStats.size)) {
    await fs.copyFile(source, destination);
  }
  return sourceStats.size;
}

function getVideoSourceDirectories() {
  return [...new Set([DEPLOYED_VIDEO_DIR, EXTERNAL_VIDEO_DIR]
    .filter(Boolean)
    .map(directory => path.resolve(directory)))];
}

async function discoverAvailableClips() {
  const curatedFilenames = new Set(videoClipsData.map(clip => clip.filename.toLowerCase()));
  const clipsByFilename = new Map();

  // Scan the deployed directory first. If an optional import folder contains
  // the same filename, the deployed version remains authoritative.
  for (const sourceDirectory of getVideoSourceDirectories()) {
    let entries = [];
    try { entries = await fs.readdir(sourceDirectory, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.mp4$/i.test(entry.name)) continue;
      const filenameKey = entry.name.toLowerCase();
      if (curatedFilenames.has(filenameKey) || clipsByFilename.has(filenameKey)) continue;
      clipsByFilename.set(filenameKey, { filename: entry.name, sourcePath: path.join(sourceDirectory, entry.name) });
    }
  }

  return [...clipsByFilename.values()]
    .sort((left, right) => left.filename.localeCompare(right.filename))
    .map((clip, index) => {
    const focus = VIDEO_FOCUSES[index % VIDEO_FOCUSES.length];
    // The source filename is the durable identity. Do not include its sorted
    // position: a user adding/removing a clip must never create duplicates.
    const stableId = crypto.createHash('sha1').update(clip.filename.toLowerCase()).digest('hex').slice(0, 18).toUpperCase();
    return {
      ...clip,
      videoId: `VID_STOCK_${stableId}`,
      title: `${focus.title} · clip ${index + 1}`,
      difficulty: index % 5 === 0 ? 'hard' : index % 2 ? 'medium' : 'easy',
      taskAiNumber: focus.taskAiNumber,
      focus: focus.focus,
      prompt: focus.prompt,
      actionSequences: []
    };
  });
}

async function registerAllVideos(db) {
  const registeredVideos = [];
  const discoveredClips = await discoverAvailableClips();
  const allClips = videoClipsData.map((clip, index) => ({ ...clip, taskAiNumber: clip.taskAiNumber || '5', focus: clip.focus || 'ordered motion sequences', prompt: clip.prompt || 'Mark every movement in order with accurate start and end times.' }));
  for (const clip of [...allClips, ...discoveredClips]) {
    const fileSize = await copyClipToVideoDirectory(clip);
    const record = { ...clip, duration: CLIP_DURATION_MS, resolution: '1280x720', fps: 24, fileSize, status: 'active' };
    await db.query(`
      INSERT INTO videos (video_id, title, filename, duration, resolution, fps, file_size, mime_type, action_sequences, difficulty, status, task_ai_number, focus, prompt)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT(video_id) DO UPDATE SET
        title = excluded.title, filename = excluded.filename, duration = excluded.duration,
        resolution = excluded.resolution, fps = excluded.fps, file_size = excluded.file_size,
        mime_type = excluded.mime_type, action_sequences = excluded.action_sequences,
        difficulty = excluded.difficulty, status = excluded.status, task_ai_number = excluded.task_ai_number,
        focus = excluded.focus, prompt = excluded.prompt
    `, [record.videoId, record.title, record.filename, record.duration, record.resolution, record.fps,
      record.fileSize, 'video/mp4', JSON.stringify(record.actionSequences), record.difficulty, record.status,
      record.taskAiNumber, record.focus, record.prompt]);
    registeredVideos.push(record);
  }
  return { registeredVideos, successCount: registeredVideos.length, errorCount: 0, durationSeconds: CLIP_DURATION_SECONDS };
}

module.exports = {
  videoClipsData,
  registerAllVideos,
  discoverAvailableClips,
  getVideoSourceDirectories,
  CLIP_DURATION_MS,
  CLIP_DURATION_SECONDS
};
