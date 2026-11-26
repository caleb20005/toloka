class VideoTaskHandler {
  constructor() {
    this.annotations = [];
    this.duration = 10;
    this.container = null;
    this.video = null;
    this.marking = false;
  }

  initialize(container, clip) {
    this.destroy();
    this.container = container;
    this.duration = Number(clip.durationMs || 10010) / 1000;
    this.annotations = [];
    this.ensureStyles();

    const modes = this.modesForFocus(clip.focus);
    const metric = clip.trainingMetric || null;
    container.innerHTML = `
      <section class="action-task" aria-label="Action sequence annotation">
        <div class="action-task-heading">
          <strong>${this.escape(clip.title || 'Action sequence')}</strong>
          <span>${this.duration.toFixed(1)} seconds</span>
        </div>
        <div class="action-task-focus"><b>${this.escape(clip.focus || 'motion sequence')}</b><span>${this.escape(clip.question || 'Mark the visible evidence in this clip.')}</span></div>
        ${metric ? `<section class="ai-training-meter" aria-label="AI training progress"><div><span>Training signal</span><b>${metric.signalLabel || 'Collecting evidence'}</b></div><strong>${Number(metric.progress || 0)}%</strong><i><em style="width:${Math.max(0, Math.min(100, Number(metric.progress || 0)))}%"></em></i><small>${Number(metric.contributions || 0).toLocaleString()} validated annotations · ${Number(metric.clipsAnnotated || 0).toLocaleString()} clips reviewed</small></section>` : ''}
        <div class="action-video-stage">
          <video class="action-task-video" controls preload="metadata" playsinline>
            <source src="${this.escape(clip.url)}" type="video/mp4">
            Your browser does not support video playback.
          </video>
          <div class="action-marker-layer" aria-label="Video marker layer"></div>
        </div>
        <p class="action-task-help">${this.escape(clip.question || 'Watch once, then mark the visible evidence in time order. Use the player’s current time to set a boundary precisely.')}</p>
        <div class="action-task-time"><span>Player time</span><output>0.0s</output><button type="button" class="action-use-time">Use as start</button><button type="button" class="action-use-time action-use-end">Use as end</button><button type="button" class="action-place-marker">Place visual marker</button></div>
        <div class="action-task-form">
          <label>What do you observe?<input class="action-label-input" maxlength="120" placeholder="e.g. ${this.escape(modes.placeholder)}" autocomplete="off"></label>
          <label>Start (s)<input class="action-start-input" type="number" min="0" max="${this.duration.toFixed(2)}" step="0.1" value="0"></label>
          <label>End (s)<input class="action-end-input" type="number" min="0" max="${this.duration.toFixed(2)}" step="0.1" value="1"></label>
          <button type="button" class="action-add">Add movement</button>
        </div>
        <div class="action-task-shortcuts" aria-label="Action suggestions">
          ${modes.labels.map(action => `<button type="button" data-label="${this.escape(action)}">${this.escape(action)}</button>`).join('')}
        </div>
        <div class="action-task-error" role="alert" aria-live="polite"></div>
        <ol class="action-task-list"></ol>
      </section>`;

    this.video = container.querySelector('.action-task-video');
    const markerLayer = container.querySelector('.action-marker-layer');
    const output = container.querySelector('output');
    const start = container.querySelector('.action-start-input');
    const end = container.querySelector('.action-end-input');
    const label = container.querySelector('.action-label-input');
    this.video.addEventListener('timeupdate', () => { output.textContent = `${this.video.currentTime.toFixed(1)}s`; });
    container.querySelector('.action-use-time').addEventListener('click', () => { start.value = this.video.currentTime.toFixed(1); });
    container.querySelector('.action-use-end').addEventListener('click', () => { end.value = this.video.currentTime.toFixed(1); });
    container.querySelector('.action-add').addEventListener('click', () => this.add());
    container.querySelector('.action-place-marker').addEventListener('click', () => {
      const selectedLabel = label.value.trim();
      if (!selectedLabel) return this.showError('Choose or enter a label before placing a visual marker.');
      this.marking = true;
      markerLayer.classList.add('placing');
      markerLayer.setAttribute('aria-label', 'Click the object or visible cue to mark it');
      this.showError('Click the object or cue in the clip to place a marker.');
    });
    markerLayer.addEventListener('click', (event) => {
      if (!this.marking) return;
      const bounds = markerLayer.getBoundingClientRect();
      const x = Math.max(0, Math.min(100, ((event.clientX - bounds.left) / bounds.width) * 100));
      const y = Math.max(0, Math.min(100, ((event.clientY - bounds.top) / bounds.height) * 100));
      const now = Math.min(Math.max(0, this.video.currentTime), Math.max(0, this.duration - 0.35));
      this.add({ x, y, startTime: now, endTime: Math.min(this.duration, now + 0.6), kind: 'visual-marker' });
      this.marking = false;
      markerLayer.classList.remove('placing');
    });
    container.querySelectorAll('[data-label]').forEach(button => button.addEventListener('click', () => {
      label.value = button.dataset.label;
      label.focus();
    }));
    label.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); this.add(); } });
    this.render();
  }

  add(marker = null) {
    if (this.annotations.length >= 6) return this.showError('A clip can have at most six movement tags.');
    const label = this.container.querySelector('.action-label-input').value.trim();
    const startTime = marker ? marker.startTime : Number(this.container.querySelector('.action-start-input').value);
    const endTime = marker ? marker.endTime : Number(this.container.querySelector('.action-end-input').value);
    if (!label) return this.showError('Describe the movement before adding it.');
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime < 0 || endTime > this.duration || startTime >= endTime) {
      return this.showError(`Choose a valid range between 0.0 and ${this.duration.toFixed(1)} seconds.`);
    }
    if (this.annotations.some(action => startTime < action.endTime && endTime > action.startTime)) {
      return this.showError('Each movement needs its own non-overlapping time range.');
    }
    this.annotations.push({ label, startTime: Number(startTime.toFixed(1)), endTime: Number(endTime.toFixed(1)), ...(marker ? { x: Number(marker.x.toFixed(1)), y: Number(marker.y.toFixed(1)), kind: marker.kind } : {}) });
    this.annotations.sort((a, b) => a.startTime - b.startTime);
    this.container.querySelector('.action-label-input').value = '';
    this.container.querySelector('.action-start-input').value = endTime.toFixed(1);
    this.container.querySelector('.action-end-input').value = Math.min(this.duration, endTime + 1).toFixed(1);
    this.showError('');
    this.render();
  }

  render() {
    if (!this.container) return;
    const list = this.container.querySelector('.action-task-list');
    const markerLayer = this.container.querySelector('.action-marker-layer');
    list.replaceChildren();
    markerLayer.replaceChildren();
    if (!this.annotations.length) {
      const empty = document.createElement('li');
      empty.className = 'action-task-empty';
      empty.textContent = 'No movements added yet.';
      list.appendChild(empty);
      return;
    }
    this.annotations.forEach((action, index) => {
      if (Number.isFinite(action.x) && Number.isFinite(action.y)) {
        const marker = document.createElement('i');
        marker.className = 'action-visual-marker';
        marker.style.left = `${action.x}%`;
        marker.style.top = `${action.y}%`;
        marker.title = action.label;
        marker.textContent = String(index + 1);
        markerLayer.appendChild(marker);
      }
      const item = document.createElement('li');
      const text = document.createElement('span');
      text.textContent = `${action.startTime.toFixed(1)}s–${action.endTime.toFixed(1)}s: ${action.label}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => { this.annotations.splice(index, 1); this.render(); });
      item.append(text, remove);
      list.appendChild(item);
    });
  }

  validate() {
    if (this.annotations.length < 2) return { valid: false, message: 'Add at least two distinct movements before submitting.' };
    return { valid: true };
  }

  getActionSequences() { return this.annotations.map(action => ({ ...action })); }

  modesForFocus(focus) {
    const modes = {
      'object identification': { placeholder: 'blue cup on the table', labels: ['Person', 'Vehicle', 'Phone', 'Cup', 'Door', 'Object enters frame', 'Object leaves frame'] },
      'human gestures': { placeholder: 'person waves to the camera', labels: ['Waving', 'Pointing', 'Nodding', 'Shaking head', 'Hand raise', 'Looking away', 'Approaching'] },
      'fine-grained actions': { placeholder: 'hand places object on surface', labels: ['Reaching', 'Grasping', 'Lifting', 'Placing', 'Turning', 'Sliding', 'Releasing'] },
      'safety and risk cues': { placeholder: 'person steps near moving object', labels: ['Obstacle', 'Near collision', 'Unsafe reach', 'Protective action', 'Hazard present', 'Clear path', 'Attention shift'] },
      'mood and social context': { placeholder: 'visible smile while greeting', labels: ['Smile', 'Frown', 'Neutral expression', 'Engaged gaze', 'Avoiding gaze', 'Greeting gesture', 'Hesitation'] },
      'ordered motion sequences': { placeholder: 'grasping the door handle', labels: ['Reaching', 'Grasping', 'Turning', 'Lifting', 'Pulling', 'Sliding', 'Releasing'] }
    };
    return modes[focus] || modes['ordered motion sequences'];
  }

  showError(message) { if (this.container) this.container.querySelector('.action-task-error').textContent = message; }

  destroy() {
    if (this.video) { this.video.pause(); this.video.removeAttribute('src'); this.video.load(); }
    if (this.container) this.container.replaceChildren();
    this.video = null;
    this.container = null;
    this.annotations = [];
    this.marking = false;
  }

  escape(value) {
    return String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
  }

  ensureStyles() {
    if (document.getElementById('action-task-styles')) return;
    const style = document.createElement('style');
    style.id = 'action-task-styles';
    style.textContent = [
      // Layout — shared by both themes.
      '.action-task{display:grid;gap:12px;text-align:left}',
      '.action-task-heading,.action-task-time,.action-task-list li{display:flex;align-items:center;justify-content:space-between;gap:10px}',
      '.action-task-focus{display:grid;gap:4px;padding:10px 12px;border-radius:10px;background:#eef2ff;color:#1f2a5d;font-size:.9rem}.action-task-focus b{text-transform:uppercase;letter-spacing:.08em;font-size:.7rem}',
      '.ai-training-meter{display:grid;grid-template-columns:1fr auto;gap:6px 12px;padding:12px;border:1px solid #c7d2fe;border-radius:10px;background:#f8faff;color:#172554}.ai-training-meter div{display:grid;gap:2px}.ai-training-meter div span{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em}.ai-training-meter>strong{font-size:1.1rem}.ai-training-meter i{grid-column:1/-1;height:7px;border-radius:999px;background:#dbe4ff;overflow:hidden}.ai-training-meter i em{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#4f46e5,#22c55e)}.ai-training-meter small{grid-column:1/-1;color:#475569;font-size:.78rem}',
      '.action-video-stage{position:relative}.action-task-video{display:block;width:100%;max-height:min(52vh,420px);background:#111;border-radius:10px}.action-marker-layer{position:absolute;inset:0;pointer-events:none}.action-marker-layer.placing{pointer-events:auto;cursor:crosshair;background:rgba(79,70,229,.08);outline:2px solid #818cf8;outline-offset:-2px}.action-visual-marker{position:absolute;display:grid;place-items:center;width:28px;height:28px;transform:translate(-50%,-50%);border:3px solid #fff;border-radius:999px;background:#4f46e5;color:#fff;font:700 12px/1 Arial;box-shadow:0 2px 8px rgba(0,0,0,.45);pointer-events:none}',
      '.action-task-form{display:grid;grid-template-columns:minmax(200px,1fr) 96px 96px auto;gap:8px;align-items:end}',
      '.action-task-form label{display:grid;gap:4px;font-size:.82rem;font-weight:600}',
      '.action-task-shortcuts{display:flex;flex-wrap:wrap;gap:6px}',
      '.action-task-error{min-height:1.1em;font-size:.88rem}',
      '.action-task-list{display:grid;gap:6px;margin:0;padding:0;list-style:none}',
      '.action-task-list li{padding:9px 10px;border-radius:7px;font-size:.9rem}',
      '.action-task-time{padding:9px 10px;border-radius:8px;font-size:.9rem;flex-wrap:wrap}',
      '.action-task-time output{font-variant-numeric:tabular-nums;font-weight:700}',
      '.action-task-empty{justify-content:center;font-style:italic}',
      // Compact inputs — neutralize the site-wide oversized form styling.
      '.action-task .action-task-form input{box-sizing:border-box;width:100%!important;padding:8px 9px!important;border:1px solid #d1d5db!important;border-radius:6px!important;font:inherit!important;background:#fff!important;color:#111827!important}',
      // Compact buttons — neutralize the site-wide pill/gradient button styling.
      '.action-task .action-use-time,.action-task .action-task-shortcuts button{display:inline-flex!important;align-items:center!important;min-height:0!important;width:auto!important;padding:5px 9px!important;background:#fff!important;border:1px solid #d1d5db!important;border-radius:6px!important;color:#374151!important;font-size:.82rem!important;font-weight:600!important;box-shadow:none!important;cursor:pointer}',
      '.action-task .action-add{display:inline-flex!important;align-items:center!important;justify-content:center!important;min-height:0!important;width:auto!important;padding:9px 14px!important;background:#4f46e5!important;border:1px solid #4f46e5!important;border-radius:6px!important;color:#fff!important;font-size:.88rem!important;font-weight:700!important;box-shadow:none!important;cursor:pointer}',
      '.action-task .action-task-list button{display:inline-flex!important;min-height:0!important;width:auto!important;padding:2px 6px!important;background:transparent!important;border:0!important;border-radius:6px!important;color:#b91c1c!important;font-size:.82rem!important;font-weight:600!important;box-shadow:none!important;cursor:pointer}',
      // Light theme text colours.
      '.action-task-heading span{color:#6b7280;font-size:.86rem}',
      '.action-task-help{margin:0;color:#4b5563;font-size:.9rem}',
      '.action-task-time{background:#f3f4f6;color:#111827}',
      '.action-task-form label{color:#4b5563}',
      '.action-task-error{color:#b91c1c}',
      '.action-task-list li{border:1px solid #e5e7eb;background:#fafafa;color:#111827}',
      '.action-task-empty{color:#6b7280}',
      // Dark theme — light text on dark chips so nothing blends into the modal.
      'html:not([data-theme="light"]) .action-task-heading span{color:#94a3b8}',
      'html:not([data-theme="light"]) .action-task-focus{background:#18264a;color:#e0e7ff}.html:not([data-theme="light"]) .ai-training-meter{background:#111e3b;border-color:#304673;color:#e0e7ff}.html:not([data-theme="light"]) .ai-training-meter small{color:#b7c4e0}.html:not([data-theme="light"]) .ai-training-meter i{background:#26385f}',
      'html:not([data-theme="light"]) .action-task-help{color:#cbd5e1}',
      'html:not([data-theme="light"]) .action-task-time{background:rgba(255,255,255,.06);color:#f8fafc}',
      'html:not([data-theme="light"]) .action-task-form label{color:#cbd5e1}',
      'html:not([data-theme="light"]) .action-task .action-task-form input{background:#f8fafc!important;border-color:#94a3b8!important;color:#0f172a!important}',
      'html:not([data-theme="light"]) .action-task .action-use-time,html:not([data-theme="light"]) .action-task .action-task-shortcuts button{background:#1e293b!important;border-color:#334155!important;color:#e5e7eb!important}',
      'html:not([data-theme="light"]) .action-task-error{color:#fca5a5}',
      'html:not([data-theme="light"]) .action-task-list li{border-color:#334155;background:#111827;color:#f8fafc}',
      'html:not([data-theme="light"]) .action-task-empty{color:#94a3b8}',
      '@media(max-width:600px){.action-task-form{grid-template-columns:1fr 1fr}.action-task-form label:first-child{grid-column:1/-1}.action-task .action-add{grid-column:1/-1}}'
    ].join('');
    document.head.appendChild(style);
  }
}

window.videoTaskHandler = new VideoTaskHandler();
