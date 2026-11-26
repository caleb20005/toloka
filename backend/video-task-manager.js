/**
 * Video Task Management Module
 * Handles video uploads, storage, and action sequence validation
 * 
 * Requirements:
 * - Videos must be 4 seconds long (±0.2s tolerance)
 * - MP4 format with H.264 codec
 * - Resolution: 1280x720 or better
 * - Frame rate: 24, 25, 30, or 60 fps
 * 
 * Action Sequence Requirements:
 * - Minimum 2 micro-movements per video
 * - Maximum 6 micro-movements per video
 * - Non-overlapping time ranges
 * - Each movement 0.5s - 2.5s duration
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// Video task database schema (to be added to db.js)
const videoTaskSchema = `
CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  filename TEXT NOT NULL,
  duration REAL NOT NULL,
  resolution TEXT,
  fps INTEGER,
  file_size INTEGER,
  mime_type TEXT,
  uploaded_by INTEGER,
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  action_sequences JSON,
  difficulty TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS video_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challenge_id TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL,
  video_id INTEGER NOT NULL,
  user_annotations JSON NOT NULL,
  expected_actions JSON NOT NULL,
  accuracy_score REAL,
  completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (video_id) REFERENCES videos(id)
);

CREATE TABLE IF NOT EXISTS video_metadata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL,
  codec TEXT,
  bitrate INTEGER,
  color_space TEXT,
  duration_ms INTEGER,
  FOREIGN KEY (video_id) REFERENCES videos(id)
);
`;

class VideoTaskManager {
  constructor(uploadDir = './backend/videos') {
    this.uploadDir = uploadDir;
    this.maxFileSize = 100 * 1024 * 1024; // 100MB
    this.allowedMimeTypes = ['video/mp4', 'video/quicktime'];
    this.videoDurationTolerance = 200; // ±200ms
  }

  /**
   * Ensure upload directory exists
   */
  async ensureUploadDir() {
    try {
      await fs.mkdir(this.uploadDir, { recursive: true });
    } catch (error) {
      console.error('Error creating upload directory:', error);
    }
  }

  /**
   * Validate video file
   * @param {Object} file - Express multer file object
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  validateVideoFile(file) {
    const errors = [];

    if (!file) {
      errors.push('No file provided');
      return { valid: false, errors };
    }

    if (file.size > this.maxFileSize) {
      errors.push(`File size exceeds ${this.maxFileSize / 1024 / 1024}MB limit`);
    }

    if (!this.allowedMimeTypes.includes(file.mimetype)) {
      errors.push(`Invalid MIME type. Allowed: ${this.allowedMimeTypes.join(', ')}`);
    }

    if (!file.originalname.toLowerCase().match(/\.(mp4|mov)$/)) {
      errors.push('File must be .mp4 or .mov format');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Process uploaded video and extract metadata
   * NOTE: Full implementation requires ffprobe/ffmpeg
   * This is a placeholder that validates structure
   * 
   * @param {string} filePath - Path to uploaded video
   * @returns {Object} Video metadata
   */
  async extractVideoMetadata(filePath) {
    // Placeholder - actual implementation uses ffprobe
    // Example output structure:
    return {
      duration: 4000, // ms
      fps: 30,
      resolution: '1280x720',
      codec: 'h264',
      bitrate: 5000000,
      colorSpace: 'yuv420p'
    };
  }

  /**
   * Validate action sequences provided for a video
   * @param {Array} actions - Array of action objects with startTime, endTime, label
   * @returns {Object} { valid: boolean, errors: string[], warnings: string[] }
   */
  validateActionSequences(actions, durationSeconds = 10) {
    const errors = [];
    const warnings = [];

    if (!Array.isArray(actions) || actions.length === 0) {
      errors.push('At least one action sequence required');
      return { valid: false, errors, warnings };
    }

    if (actions.length > 6) {
      errors.push('Maximum 6 action sequences per video');
    }

    if (actions.length < 2) {
      warnings.push('Recommended minimum 2 action sequences for better training');
    }

    // Validate each action
    actions.forEach((action, index) => {
      if (!action.label || typeof action.label !== 'string') {
        errors.push(`Action ${index + 1}: Missing or invalid label`);
      }

      const startTime = parseFloat(action.startTime);
      const endTime = parseFloat(action.endTime);

      if (isNaN(startTime) || startTime < 0 || startTime > durationSeconds) {
        errors.push(`Action ${index + 1}: Invalid start time`);
      }

      if (isNaN(endTime) || endTime < 0 || endTime > durationSeconds) {
        errors.push(`Action ${index + 1}: Invalid end time`);
      }

      if (startTime >= endTime) {
        errors.push(`Action ${index + 1}: Start time must be before end time`);
      }

      const duration = endTime - startTime;
      if (duration < 0.5) {
        warnings.push(`Action ${index + 1}: Very short duration (${duration.toFixed(2)}s) may be hard to annotate`);
      }

      if (duration > 2.5) {
        warnings.push(`Action ${index + 1}: Long duration (${duration.toFixed(2)}s) should be split into smaller actions`);
      }

      if (action.label.length > 100) {
        errors.push(`Action ${index + 1}: Label too long (max 100 characters)`);
      }
    });

    // Check for overlapping actions
    const sorted = [...actions].sort((a, b) => a.startTime - b.startTime);
    for (let i = 0; i < sorted.length - 1; i++) {
      if (sorted[i].endTime > sorted[i + 1].startTime) {
        errors.push(`Actions ${i + 1} and ${i + 2} overlap`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Register a video with metadata and action sequences
   * @param {Object} params
   * @returns {Promise<Object>}
   */
  async registerVideo(params) {
    const {
      filePath,
      title,
      actionSequences,
      metadata,
      difficulty = 'medium',
      uploadedBy = null
    } = params;

    const videoId = `VID_${crypto.randomBytes(8).toString('hex')}`;
    const filename = path.basename(filePath);

    // Validate actions
    const durationSeconds = Number(metadata?.duration || 0) > 100 ? Number(metadata.duration) / 1000 : Number(metadata?.duration || 10);
    const validation = this.validateActionSequences(actionSequences, durationSeconds);
    if (!validation.valid) {
      throw new Error(`Action sequence validation failed: ${validation.errors.join(', ')}`);
    }

    return {
      videoId,
      title,
      filename,
      duration: metadata.duration,
      resolution: metadata.resolution,
      fps: metadata.fps,
      actionSequences,
      difficulty,
      metadata: {
        codec: metadata.codec,
        bitrate: metadata.bitrate,
        colorSpace: metadata.colorSpace
      },
      uploadedBy,
      uploadedAt: new Date().toISOString(),
      status: 'active',
      warnings: validation.warnings
    };
  }

  /**
   * Score user's action annotations
   * Compares user-tagged actions with expected actions
   * 
   * @param {Array} userAnnotations - Actions tagged by user
   * @param {Array} expectedActions - Expected action sequences
   * @returns {Object} { score: number, feedback: string[], details: Object }
   */
  scoreActionSequence(userAnnotations, expectedActions) {
    const feedback = [];
    const details = {
      totalExpected: expectedActions.length,
      userTagged: userAnnotations.length,
      correctLabels: 0,
      timingAccuracy: [],
      overallMatch: 0
    };

    if (userAnnotations.length === 0) {
      return {
        score: 0,
        feedback: ['No actions were tagged'],
        details
      };
    }

    // Check if user tagged all expected actions (with tolerance)
    expectedActions.forEach((expected, index) => {
      const found = userAnnotations.find(annotation => {
        const timeDiff = Math.abs(annotation.startTime - expected.startTime) +
          Math.abs(annotation.endTime - expected.endTime);
        return timeDiff < 1; // Within 1 second tolerance
      });

      if (found) {
        details.correctLabels++;
        const labelMatch = found.label.toLowerCase().includes(
          expected.label.toLowerCase().split(' ')[0]
        );
        if (labelMatch) {
          feedback.push(`✓ Action ${index + 1} correctly identified and labeled`);
        } else {
          feedback.push(`~ Action ${index + 1} found at correct time but label differs`);
        }
      } else {
        feedback.push(`✗ Action ${index + 1} (${expected.label}) was not tagged`);
      }
    });

    // Calculate accuracy score (0-100)
    const labelAccuracy = (details.correctLabels / expectedActions.length) * 100;
    const taggingCompleteness = Math.min(
      (userAnnotations.length / expectedActions.length) * 100,
      100
    );
    const score = Math.round((labelAccuracy + taggingCompleteness) / 2);

    return {
      score: Math.max(0, Math.min(100, score)),
      feedback,
      details
    };
  }

  /**
   * Generate task from video
   * Creates CAPTCHA challenge with video clip
   * 
   * @param {Object} video - Video document from database
   * @returns {Object} Training task object
   */
  generateVideoTask(video) {
    return {
      taskType: 'action-sequence',
      videoId: video.video_id,
      videoUrl: `/api/video/${video.video_id}/stream`,
      thumbnailUrl: `/api/video/${video.video_id}/thumbnail`,
      duration: video.duration,
      question: `Watch this ${(Number(video.duration || 10000) / 1000).toFixed(1)}-second video and tag each micro-movement. Identify when each action starts and ends, and describe what movement is happening.`,
      expectedSequences: video.action_sequences,
      difficulty: video.difficulty,
      inputMode: 'video-annotation',
      hints: [
        'Watch the full video first to get context',
        'Look for distinct hand/body movements',
        'Note the exact start and end time of each movement',
        'Be specific about what physical action is occurring'
      ]
    };
  }
}

module.exports = VideoTaskManager;
